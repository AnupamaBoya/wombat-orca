import { promises as fs } from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { runOrcaBpiCpuNotebook } from '@test-helpers/orca-bpi-cpu-notebook';

test(
    'Orca > Extract downloaded claim with notebook CPU pipeline',
    { tag: ['@Regression', '@Orca', '@ClaimsTest', '@OCR', '@NotebookCPU'] },
    async () => {
        test.setTimeout(60 * 60_000);
        const documentPath = process.env.ORCA_BPI_DOCUMENT_PATH;
        test.skip(
            !documentPath,
            'Set ORCA_BPI_DOCUMENT_PATH to the downloaded attachment to run the notebook CPU pipeline.'
        );
        const resolvedDocumentPath = path.resolve(documentPath!);
        await test.step('Run the notebook extraction cells on CPU and verify exports', async () => {
            const extraction = await runOrcaBpiCpuNotebook(resolvedDocumentPath);
            expect(extraction.metadata.total_documents).toBeGreaterThan(0);
            expect(extraction.metadata.documents).toHaveLength(extraction.metadata.total_documents);
        });
    }
);
