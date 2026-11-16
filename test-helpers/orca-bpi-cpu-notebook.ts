import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

type JsonRecord = Record<string, unknown>;
type NotebookMetadata = JsonRecord & {
    total_documents: number;
    documents: unknown[];
    invoice_summaries: unknown[];
    invoice_adjustments: unknown[];
};

export interface NotebookExtraction {
    workDirectory: string;
    metadata: NotebookMetadata;
    petGroups: unknown[];
    reviewItems: unknown[];
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
    const content = await fs.readFile(filePath, 'utf8');
    try {
        const parsed: unknown = JSON.parse(content);
        return parsed;
    } catch (error) {
        throw new Error(`Invalid JSON in ${filePath}: ${String(error)}`);
    }
}

function runNotebookCpu(
    pythonExecutable: string,
    runnerPath: string,
    notebookPath: string,
    documentPath: string,
    workDirectory: string,
    projectRoot: string
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            pythonExecutable,
            [
                '-u',
                runnerPath,
                '--notebook',
                notebookPath,
                '--document',
                documentPath,
                '--work-dir',
                workDirectory
            ],
            {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
                    TOKENIZERS_PARALLELISM: 'false'
                },
                windowsHide: true
            }
        );
        let stderr = '';
        child.stdout.resume();
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-4000);
        });
        child.once('error', error => {
            reject(new Error(`Could not start notebook CPU runner (${pythonExecutable}): ${error.message}`));
        });
        child.once('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`Notebook CPU runner exited with code ${code}. ${stderr.trim()}`));
        });
    });
}

export async function runOrcaBpiCpuNotebook(documentPath: string): Promise<NotebookExtraction> {
    const resolvedDocumentPath = path.resolve(documentPath);
    const documentStats = await fs.stat(resolvedDocumentPath);
    if (!documentStats.isFile()) {
        throw new Error(`OCR input is not a file: ${resolvedDocumentPath}`);
    }

    const projectRoot = path.resolve(
        process.env.CLAIM_OCR_PROJECT_ROOT
            ?? path.resolve(process.cwd(), '..', 'bpi_playwright_handoff_repo')
    );
    const pythonExecutable = process.env.CLAIM_OCR_PYTHON
        ?? path.join(
            projectRoot,
            '.venv-py311',
            process.platform === 'win32' ? 'Scripts' : 'bin',
            process.platform === 'win32' ? 'python.exe' : 'python'
        );
        const runnerPath = path.resolve(__dirname, '..', 'scripts', 'run_orca_bpi_cpu.py');
        const notebookPath = path.join(projectRoot, 'notebooks', 'ORCA_BPI_code.ipynb');
    const outputRoot = path.resolve(
        process.env.ORCA_BPI_RUNS_DIR
            ?? path.join(path.dirname(resolvedDocumentPath), 'notebook-cpu-runs')
    );
    const workDirectory = path.join(
        outputRoot,
        `${path.parse(resolvedDocumentPath).name}-${Date.now()}`
    );

    await runNotebookCpu(
        pythonExecutable,
        runnerPath,
        notebookPath,
        resolvedDocumentPath,
        workDirectory,
        projectRoot
    );

    const outputDirectory = path.join(workDirectory, 'outputs');
    const metadata = await readJson(path.join(outputDirectory, 'all_extracted_metadata.json'));
    const petGroups = await readJson(path.join(outputDirectory, 'pet_wise_line_items.json'));
    const reviewItems = await readJson(path.join(outputDirectory, 'human_review_required.json'));

    if (!isRecord(metadata)) {
        throw new Error('all_extracted_metadata.json must contain a JSON object.');
    }
    const documents = metadata.documents;
    const invoiceSummaries = metadata.invoice_summaries;
    const invoiceAdjustments = metadata.invoice_adjustments;
    if (!Array.isArray(documents) || !Array.isArray(invoiceSummaries)
        || !Array.isArray(invoiceAdjustments)) {
        throw new Error('Notebook metadata export is missing its expected arrays.');
    }
    const totalDocuments = metadata.total_documents;
    if (typeof totalDocuments !== 'number'
        || totalDocuments !== documents.length
        || documents.length === 0) {
        throw new Error('Notebook metadata export has an invalid document count.');
    }
    if (!Array.isArray(petGroups) || !Array.isArray(reviewItems)) {
        throw new Error('Notebook exports for pet items and human review must be arrays.');
    }
    const archivePath = path.join(workDirectory, 'orca_extracted_claim_data.zip');
    const archiveStats = await fs.stat(archivePath);
    if (!archiveStats.isFile()) {
        throw new Error(`Notebook archive is not a file: ${archivePath}`);
    }

    const validatedMetadata: NotebookMetadata = {
        ...metadata,
        total_documents: totalDocuments,
        documents,
        invoice_summaries: invoiceSummaries,
        invoice_adjustments: invoiceAdjustments
    };
    return {
        workDirectory,
        metadata: validatedMetadata,
        petGroups,
        reviewItems
    };
}
