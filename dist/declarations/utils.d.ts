import { Field } from "./types";
export default class Utils {
    static wrap(op: string | string[]): string;
    static fieldsToSql(fields: Field[]): string;
    static resolve(obj: {}, path: string, defValue?: any): any;
    static eachAsync(data: any, iterator: any, callback: any): void;
    static unstringifyDoc(doc: any, id: any, rev: any): any;
    static safeJsonParse(str: any): any;
}
