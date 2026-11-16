# Claim image/PDF extraction integration

## What this integration does

The Playwright framework exposes a terminal command and a reusable TypeScript service
for running the claim image/PDF extraction parser. Given an image or PDF path, it invokes the
existing Python extraction project, saves the claim-shaped JSON to a path you choose,
and reports the extraction status.

This is a local parsing flow only. It does not open a browser, upload a document to
the claims portal, or submit a claim. Every extraction remains subject to human
review.

## Prerequisites

1. Use Node.js and install this framework's dependencies from `Wombat-Claims`:

   ```powershell
   npm install
   ```

2. Ensure the sibling `bpi_playwright_handoff_repo` is present and the OCR
   dependencies/model runtime are installed in its Python 3.11.9 environment. The
   default expected interpreter is:

   ```text
   ..\bpi_playwright_handoff_repo\.venv-py311\Scripts\python.exe
   ```

   See the extraction project's README for installing the pinned OCR dependencies
   and CPU PaddlePaddle runtime. PaddleOCR-VL-1.5 may download its model files on first use.

3. If the extraction project or Python interpreter is in a different location, set:

   ```powershell
   $env:CLAIM_OCR_PROJECT_ROOT = "C:\path\to\bpi_playwright_handoff_repo"
   $env:CLAIM_OCR_PYTHON = "C:\path\to\python.exe"
   ```

   `CLAIM_OCR_PYTHON` is optional if the standard `.venv-py311` interpreter is
   available under the configured extraction root.

## Run from the terminal

From the `Wombat-Claims` directory:

```powershell
npm run ocr:claim -- --document "C:\Users\User\Pictures\Screenshots\invoice.pdf" --output "C:\Users\User\Pictures\Screenshots\invoice.json"
```

`--document` is required. `--output` is optional; when omitted, the JSON is written
beside the source document with the same base filename. The command accepts PDF,
PNG, JPG/JPEG, TIF/TIFF, and WebP files. Paths containing spaces should be quoted.
The existing `--image <path>` option remains supported as a legacy alias.
For multiple documents, repeat `--document`:

```powershell
npm run ocr:claim -- --document "C:\claims\invoice.pdf" --document "C:\claims\receipt.png" --output "C:\claims\claim-bundle.json"
```

Documents are extracted independently; the bundle reports matching or conflicting
evidence but does not merge documents or assign them to one claim automatically.
If one multipage PDF contains multiple distinct invoice-number headers, the Python
extractor emits separate invoice entries and per-invoice page numbers in both sidecar
files. Pages with unclear invoice association are retained as unassigned for review;
two invoices printed on the same page are not auto-split.

Show CLI usage:

```powershell
npm run ocr:claim -- --help
```

The command prints the combined JSON path, the two rule-specific output paths,
review status, line item count, and warning count. It does not print the extracted
claim contents to the terminal.

The combined JSON remains at the requested `--output` path. The rules-compliant
`claim_metadata.json` and `pet_wise_line_items.json` files are written under a
same-named subfolder beside it. For example, `invoice.json` produces
`invoice\claim_metadata.json` and `invoice\pet_wise_line_items.json`.

## Run as an Orca claims test

The optional Playwright spec at
`tests/orca/claims/ocr-image-to-json.spec.ts` uses the same service and checks that
the JSON file is saved and marked for human review. Set the image path and, optionally,
the output path before running it:

```powershell
$env:CLAIM_OCR_DOCUMENT_PATH = "C:\path\to\invoice.pdf"
$env:CLAIM_OCR_OUTPUT_PATH = "C:\path\to\invoice.json"
npx playwright test tests/orca/claims/ocr-image-to-json.spec.ts --project=main-tests
```

If `CLAIM_OCR_OUTPUT_PATH` is unset, the test writes `<document-name>.json` beside the
image or PDF. The legacy `CLAIM_OCR_IMAGE_PATH` setting is still accepted. Without
either input variable, the spec is reported as skipped so normal test runs do not
require a personal document.

## Validate exports from the Colab BPI notebook

The Colab notebook's final cell downloads `orca_extracted_claim_data.zip`, containing
`all_extracted_metadata.json`, `pet_wise_line_items.json`, and
`human_review_required.json`. Extract that ZIP locally, then run the separate export
validation test:

```powershell
$env:ORCA_BPI_EXPORT_DIR = "C:\path\to\extracted\orca_extracted_claim_data"
npx playwright test tests/orca/claims/colab-notebook-export.spec.ts --project=main-tests
```

This test validates the notebook's exported JSON contracts locally. It does not
execute the Colab notebook, run OCR, or invoke `ClaimOcrService`. Without
`ORCA_BPI_EXPORT_DIR`, it is skipped.

## Run the notebook extraction locally on CPU

The claim download test now continues directly into the repository notebook's
extraction cells. After downloading the PDF, it substitutes local file input/output
for Colab upload/download, uses PaddleOCR-VL on CPU, disables the optional Qwen GPU
worker, and verifies the notebook exports. Run it with:

```powershell
npx playwright test tests/orca/claims/single-claim.spec.ts --project=main-tests
```

The runner uses `.venv-py311` by default, honors `CLAIM_OCR_PYTHON` and
`CLAIM_OCR_PROJECT_ROOT`, and writes each run under
`notebook-cpu-runs\<document-name>-<timestamp>` beside the input. CPU OCR can take
substantially longer than GPU inference; the test timeout is 60 minutes. To rerun
the CPU pipeline on an attachment that is already downloaded, set
`ORCA_BPI_DOCUMENT_PATH` and run `notebook-cpu-extraction.spec.ts`. The original
Colab notebook is not modified.

## Integration flow

1. **CLI argument parsing** — `scripts/extract-claim.ts` requires an image or PDF path,
   accepts one or more `--document` paths and an optional JSON path, and rejects
   unknown or missing arguments.
2. **TypeScript service** — the CLI calls
   `ClaimOcrService.parseDocumentToJson(documentPath, outputPath)` for one
   document or `parseDocumentsToJson(documentPaths, outputPath)` for a bundle in
   `services/claim-ocr-service.ts`.
3. **Input checks** — the service resolves paths, verifies that the image exists
   and is a file, checks the supported image extension, and prevents output from
   overwriting the image.
4. **Python invocation** — the service starts Python with `child_process.spawn`
   and passes arguments as an array (not through a shell):

   ```text
   python -m bpi_claim_extraction <document-path> [<document-path> ...] --output <json-path>
   ```

   It sets the extraction project's `src` directory on `PYTHONPATH`, runs from the
   extraction project root, and captures stderr for a useful error if Python exits
   unsuccessfully.
5. **OCR and extraction** — the Python package prefers embedded PDF text and runs
   PaddleOCR-VL-1.5 for image/scanned pages, then applies page-level document
   classification, metadata, line-item, and validation rules. Distinct invoice
   headers can split multipage PDFs into separately extracted invoice entries.
   Unknown or uncertain
   values remain unset or are marked for review.
6. **JSON persistence** — the Python extractor writes formatted UTF-8 combined JSON
   to the requested output path, plus separate metadata and pet-wise line-item JSON
   files in the output's same-named subfolder.
7. **Result checks** — the TypeScript service reads the generated file and checks
   that it has the expected top-level claim JSON shape before returning it to the
   CLI or caller.

## Calling the service from TypeScript

The same method can be called from a Playwright helper or another TypeScript workflow:

```typescript
import { ClaimOcrService } from '@services/claim-ocr-service';

const result = await new ClaimOcrService().parseDocumentToJson(
    'C:\\path\\to\\invoice.pdf',
    'C:\\path\\to\\invoice.json'
);

if (result.validation.review_required || result.status === 'needs_review') {
    // Route to a human review step; do not auto-submit.
}
```

For multiple documents:

```typescript
const bundle = await new ClaimOcrService().parseDocumentsToJson(
    ['C:\\path\\to\\invoice.pdf', 'C:\\path\\to\\receipt.png'],
    'C:\\path\\to\\claim-bundle.json'
);
```

When `outputPath` is omitted, the service saves `<document-name>.json` beside the
source. `parseImageToJson` remains available for existing image-only callers. The
returned object includes claim metadata, pet groups and line items, plus validation
warnings.

## Output and review expectations

The combined output follows `schemas/claim_output.schema.json`; the separate files
follow `schemas/claim_metadata_output.schema.json` and
`schemas/pet_wise_line_items.schema.json`. Multi-document runs also produce a
bundle following `schemas/claim_bundle.schema.json`. OCR results are marked
`needs_review` and include warnings/evidence for uncertain fields. Qwen3-4B is not
configured in the local CPU runtime, so unresolved ambiguity remains for human
review. Validate names, dates, amounts, line items, discounts/returns, and pet
assignment against the source before using the data. A structurally valid JSON file
does not mean its OCR values are correct.

The OCR service itself has no Playwright/browser side effects. A calling workflow
must keep extraction and any claim submission as separate, explicitly reviewed
steps.

## Errors and troubleshooting

- **Document not found / unsupported extension** — check the full path and use a
  supported image extension or PDF.
- **Could not start Python** — verify `CLAIM_OCR_PYTHON`, or install the expected
  Python 3.11.9 extraction environment.
- **Python OCR process failed** — inspect the error printed by the command; confirm
  the extraction dependencies and Paddle runtime were installed in that interpreter.
  If the underlying import error says Windows Application Control blocked a compiled
  extension, ask the administrator to approve it or provide an authorized runtime;
  reinstalling the OCR requirements does not override that policy.
- **Output file missing or invalid** — ensure the destination directory is writable;
  the service fails rather than treating a missing/invalid JSON file as success.
- **No/partial fields extracted** — inspect the source image and JSON warnings.
  Cropping, low resolution, glare, occlusion, unusual layouts, and OCR errors can
  cause missing or inaccurate fields.
