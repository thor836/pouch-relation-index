/// <reference types="websql" />
import { Provider } from "./provider";
export default class WebSqlProvider implements Provider {
    protected readonly db: string;
    constructor(db: string);
    executeSql(sql: string, args?: any[]): Promise<any>;
    batchSql(batch: any[]): Promise<any>;
    protected openConnection(): Database;
}
