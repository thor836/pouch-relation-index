
export type Order = { field: string, dir?: 'asc' | 'desc' };
export type Field = { name: string, type?: string };
export type IndexInfo = { name: string, doc_type: string, fields: Field[] }
