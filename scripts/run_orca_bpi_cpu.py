import argparse
import contextlib
import io
import json
import os
import sys
import types
from pathlib import Path
from typing import Any


SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}

CPU_DEVICE_CHECK = """
import paddle
paddle.set_device("cpu")
result = paddle.matmul(paddle.randn([64, 64]), paddle.randn([64, 64]))
assert "cpu" in str(result.place).lower(), result.place
"""

CPU_RUNTIME_PREFLIGHT = """
import paddle
from paddleocr import PaddleOCRVL
paddle.set_device("cpu")
if paddle.device.get_device() != "cpu":
    raise RuntimeError("Paddle could not select the CPU device.")
"""


class LocalColabFiles:
    def __init__(self, documents: list[Path]) -> None:
        self.documents = documents

    def upload(self) -> dict[str, bytes]:
        return {document.name: document.read_bytes() for document in self.documents}

    def download(self, file_path: str) -> None:
        if not Path(file_path).is_file():
            raise FileNotFoundError(f"Notebook export was not created: {file_path}")


def install_local_colab_files(documents: list[Path]) -> None:
    try:
        import google as google_module
    except ImportError:
        google_module = types.ModuleType("google")
        google_module.__path__ = []
        sys.modules["google"] = google_module

    colab_module = types.ModuleType("google.colab")
    colab_module.files = LocalColabFiles(documents)
    google_module.colab = colab_module
    sys.modules["google.colab"] = colab_module


def adapt_cell(
    index: int,
    source: str,
    work_dir: Path,
    transformations: dict[str, int],
) -> str | None:
    if "CUDA compiled:" in source and 'paddle.set_device("gpu:0")' in source:
        transformations["cpu_device_check"] += 1
        return CPU_DEVICE_CHECK

    if "Paddle GPU + PaddleOCR-VL stack first." in source:
        if not any(line.lstrip().startswith("%pip") for line in source.splitlines()):
            raise RuntimeError("The Colab installation cell no longer contains its expected %pip commands.")
        transformations["skip_colab_install"] += 1
        return None

    if "# Required runtime preflight: Paddle GPU must work" in source:
        transformations["cpu_preflight"] += 1
        return CPU_RUNTIME_PREFLIGHT

    if 'QWEN_WORKER_PATH = "/content/qwen_worker.py"' in source:
        transformations["skip_qwen_gpu_worker"] += 1
        return None

    colab_root = "ROOT=Path('/content/orca_vet_line_items')"
    if colab_root in source:
        if source.count(colab_root) != 1:
            raise RuntimeError("Expected one Colab workspace root in the notebook.")
        source = source.replace(colab_root, f"ROOT=Path({str(work_dir)!r})")
        transformations["local_workspace"] += 1

    gpu_ocr_block = (
        '            if not paddle.is_compiled_with_cuda():\n'
        '                raise RuntimeError("GPU OCR requested, but PaddlePaddle is CPU-only. '
        'Install paddlepaddle-gpu and restart runtime.")\n'
        '            paddle.set_device("gpu:0")\n'
        '            PADDLE_VL=PaddleOCRVL(device="gpu:0", use_doc_orientation_classify=True)'
    )
    if gpu_ocr_block in source:
        source = source.replace(
            gpu_ocr_block,
            '            paddle.set_device("cpu")\n'
            '            PADDLE_VL=PaddleOCRVL(device="cpu", use_doc_orientation_classify=True)',
        )
        transformations["cpu_ocr"] += 1

    for mode in ("auto", "force"):
        qwen_assignment = f'QWEN_MODE = "{mode}"'
        if qwen_assignment in source:
            source = source.replace(qwen_assignment, 'QWEN_MODE = "off"')
            transformations["disable_qwen"] += 1

    return source


def run_notebook(notebook_path: Path, documents: list[Path], work_dir: Path) -> dict[str, Any]:
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    if notebook.get("nbformat") != 4 or not isinstance(notebook.get("cells"), list):
        raise ValueError(f"Unsupported notebook format: {notebook_path}")

    work_dir.mkdir(parents=True, exist_ok=False)
    install_local_colab_files(documents)
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"

    transformations = {
        "cpu_device_check": 0,
        "skip_colab_install": 0,
        "cpu_preflight": 0,
        "skip_qwen_gpu_worker": 0,
        "local_workspace": 0,
        "cpu_ocr": 0,
        "disable_qwen": 0,
    }
    namespace: dict[str, Any] = {
        "__name__": "__main__",
        "__file__": str(notebook_path),
        "display": lambda *args, **kwargs: None,
    }

    for index, cell in enumerate(notebook["cells"]):
        if cell.get("cell_type") != "code":
            continue
        source = "".join(cell.get("source", []))
        source = adapt_cell(index, source, work_dir, transformations)
        if source is None or not source.strip():
            continue
        print(f"Running notebook cell {index} on CPU.", file=sys.stderr)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                exec(compile(source, f"{notebook_path}#cell-{index}", "exec"), namespace, namespace)
        except Exception as exc:
            raise RuntimeError(
                f"Notebook CPU execution failed in cell {index}: {type(exc).__name__}: {exc}"
            ) from exc

    if any(count != 1 for count in transformations.values()):
        raise RuntimeError(f"Notebook adaptation markers did not match exactly once: {transformations}")

    output_dir = work_dir / "outputs"
    expected_files = [
        output_dir / "all_extracted_metadata.json",
        output_dir / "pet_wise_line_items.json",
        output_dir / "human_review_required.json",
        work_dir / "orca_extracted_claim_data.zip",
    ]
    missing = [str(file_path) for file_path in expected_files if not file_path.is_file()]
    if missing:
        raise FileNotFoundError(f"Notebook did not create expected exports: {', '.join(missing)}")

    metadata = json.loads(expected_files[0].read_text(encoding="utf-8"))
    pet_groups = json.loads(expected_files[1].read_text(encoding="utf-8"))
    review_items = json.loads(expected_files[2].read_text(encoding="utf-8"))
    return {
        "output_dir": str(output_dir),
        "total_documents": metadata.get("total_documents", 0),
        "pet_groups": len(pet_groups),
        "review_items": len(review_items),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the ORCA BPI notebook's extraction cells with local CPU PaddleOCR."
    )
    parser.add_argument("--document", action="append", required=True, help="PDF or image to extract")
    parser.add_argument("--notebook", required=True, help="Path to the ORCA BPI notebook")
    parser.add_argument("--work-dir", required=True, help="New, empty notebook workspace")
    args = parser.parse_args()

    documents = [Path(value).resolve() for value in args.document]
    for document in documents:
        if not document.is_file():
            raise FileNotFoundError(f"Document is not a file: {document}")
        if document.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported document type: {document.suffix}")
    if len({document.name.lower() for document in documents}) != len(documents):
        raise ValueError("Input documents must have unique filenames.")

    result = run_notebook(
        Path(args.notebook).resolve(),
        documents,
        Path(args.work_dir).resolve()
    )
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
