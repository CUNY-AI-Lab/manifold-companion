// Text status words as people read them. The stored values are the legacy ones
// (pending, processing, ocrd, reviewed); only these labels are ever shown.
export const STATUS_LABELS = {
  pending: 'Not read yet',
  processing: 'Being read',
  ocrd: 'OCR complete',
  reviewed: 'Reviewed',
};

export const statusLabel = (status) => STATUS_LABELS[status] ?? 'Unknown status';

/** The statuses a person sets by hand (processing is set by the tool). */
export const SETTABLE_STATUSES = ['pending', 'ocrd', 'reviewed'];

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
