import { Provider } from "./provider";
export default class WebSqlProvider implements Provider {
    protected readonly db: string;
    protected readonly openDatabase: (name: string) => any;
    constructor(db: string, openDatabase?: (name: string) => any);
    executeSql(sql: string, args?: any[]): Promise<any>;
    batchSql(batch: any[]): Promise<any>;
    protected openConnection(): any;
}
