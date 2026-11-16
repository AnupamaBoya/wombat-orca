import { promises as fs } from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecordArray(value: unknown, label: string): asserts value is JsonRecord[] {
    if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
        throw new Error(`${label} must be an array of JSON objects.`);
    }
}

function assertHasProperties(record: JsonRecord, properties: string[], label: string): void {
    for (const property of properties) {
        if (!Object.prototype.hasOwnProperty.call(record, property)) {
            throw new Error(`${label} is missing the "${property}" property.`);
        }
    }
}

test(
    'Orca > Validate Colab BPI notebook exports',
    { tag: ['@Regression', '@Orca', '@ClaimsTest', '@OCR', '@NotebookExport'] },
    async () => {
        const exportDirectory = process.env.ORCA_BPI_EXPORT_DIR;
        test.skip(
            !exportDirectory,
            'Set ORCA_BPI_EXPORT_DIR to the extracted Colab notebook export directory.'
        );
        const resolvedDirectory = path.resolve(exportDirectory!);

        async function readExportJson(fileName: string): Promise<unknown> {
            const filePath = path.join(resolvedDirectory, fileName);
            const content = await fs.readFile(filePath, 'utf8');
            try {
                const parsed: unknown = JSON.parse(content);
                return parsed;
            } catch (error) {
                throw new Error(`Invalid JSON in ${filePath}: ${String(error)}`);
            }
        }

        await test.step('Validate consolidated document metadata', async () => {
            const metadata = await readExportJson('all_extracted_metadata.json');
            if (!isRecord(metadata)) {
                throw new Error('all_extracted_metadata.json must contain a JSON object.');
            }
            const documents = metadata.documents;
            assertRecordArray(documents, 'metadata.documents');
            assertRecordArray(metadata.invoice_summaries, 'metadata.invoice_summaries');
            assertRecordArray(metadata.invoice_adjustments, 'metadata.invoice_adjustments');
            if (typeof metadata.total_documents !== 'number' || !Number.isInteger(metadata.total_documents)) {
                throw new Error('metadata.total_documents must be an integer.');
            }
            expect(metadata.total_documents).toBe(documents.length);
            expect(documents.length).toBeGreaterThan(0);
        });

        await test.step('Validate pet-wise line-item export', async () => {
            const petGroups = await readExportJson('pet_wise_line_items.json');
            assertRecordArray(petGroups, 'pet_wise_line_items.json');

            for (const [index, group] of petGroups.entries()) {
                const label = `pet_wise_line_items.json entry ${index}`;
                assertHasProperties(
                    group,
                    ['pet_name', 'source_file', 'line_item_count', 'line_items'],
                    label
                );
                const lineItems = group.line_items;
                assertRecordArray(lineItems, `${label}.line_items`);
                if (typeof group.line_item_count !== 'number' || !Number.isInteger(group.line_item_count)) {
                    throw new Error(`${label}.line_item_count must be an integer.`);
                }
                expect(group.line_item_count).toBe(lineItems.length);
                for (const [itemIndex, item] of lineItems.entries()) {
                    assertHasProperties(
                        item,
                        ['description', 'quantity', 'allowed'],
                        `${label}.line_items entry ${itemIndex}`
                    );
                }
            }
        });

        await test.step('Validate human-review export', async () => {
            const reviewItems = await readExportJson('human_review_required.json');
            assertRecordArray(reviewItems, 'human_review_required.json');
            for (const [index, item] of reviewItems.entries()) {
                assertHasProperties(item, ['review_required'], `review entry ${index}`);
                expect(item.review_required).toBe(true);
            }
        });
    }
);
