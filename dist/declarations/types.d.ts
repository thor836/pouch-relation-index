export declare type Order = {
    field: string;
    dir?: 'asc' | 'desc';
};
export declare type Field = {
    name: string;
    type?: string;
    primary_key?: boolean;
};
export declare type IndexInfo = {
    name: string;
    doc_type: string;
    fields: Field[];
};
