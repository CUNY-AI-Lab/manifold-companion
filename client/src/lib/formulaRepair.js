import { api } from '../api/client';

const FORMULA_BATCH_SIZE = 8;

function shouldSplit(err) {
  return err?.status === 524 || err?.status === 522 || err?.status === 520 || err?.status === 500;
}

async function repairFormulaBatch(textId, batch) {
  try {
    const data = await api.post(`/api/texts/${textId}/formula-repair`, { formulas: batch });
    return Array.isArray(data?.formulas) ? data.formulas : [];
  } catch (err) {
    if (batch.length > 1 && shouldSplit(err)) {
      const midpoint = Math.ceil(batch.length / 2);
      const left = await repairFormulaBatch(textId, batch.slice(0, midpoint));
      const right = await repairFormulaBatch(textId, batch.slice(midpoint));
      return [...left, ...right];
    }
    if (batch.length === 1 && shouldSplit(err)) {
      return [];
    }
    throw err;
  }
}

export async function repairFormulasInBatches(textId, formulas, onProgress) {
  const repairs = [];

  for (let index = 0; index < formulas.length; index += FORMULA_BATCH_SIZE) {
    const batch = formulas.slice(index, index + FORMULA_BATCH_SIZE);
    const batchNumber = Math.floor(index / FORMULA_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(formulas.length / FORMULA_BATCH_SIZE);

    if (onProgress) {
      onProgress({
        batchNumber,
        totalBatches,
        processed: index,
        total: formulas.length,
      });
    }

    repairs.push(...await repairFormulaBatch(textId, batch));
  }

  if (onProgress) {
    onProgress({
      batchNumber: Math.ceil(formulas.length / FORMULA_BATCH_SIZE) || 1,
      totalBatches: Math.ceil(formulas.length / FORMULA_BATCH_SIZE) || 1,
      processed: formulas.length,
      total: formulas.length,
    });
  }

  return repairs;
}
