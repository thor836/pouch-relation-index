export declare type Order = {
    field: string;
    dir?: 'asc' | 'desc';
};
export declare type Field = {
    name: string;
    type?: string;
    index?: boolean;
    unique?: boolean;
};
export declare type IndexInfo = {
    name: string;
    doc_type: string;
    fields: Field[];
};
