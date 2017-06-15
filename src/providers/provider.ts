
export interface Provider {
    executeSql(sql: string, args?: any[]): Promise<any>;
    batchSql(batch: any[]): Promise<any>;
}
