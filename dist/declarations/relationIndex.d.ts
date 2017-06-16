/// <reference types="pouchdb-core" />
/// <reference types="pouchdb-mapreduce" />
/// <reference types="pouchdb-replication" />
import { Provider } from "./providers/provider";
import { IndexInfo, Order } from "./types";
export declare class RelationIndex {
    private readonly db;
    private readonly provider;
    private readonly indexes;
    constructor(db: PouchDB.Database<any>, provider: Provider);
    info(name: string): Promise<never>;
    create(options: IndexInfo): Promise<never>;
    build(name: string): Promise<any>;
    query(name: string, selector: any, order?: Order[], include_docs?: boolean): Promise<never>;
    remove(name: string): Promise<any>;
    update(name: string): Promise<never>;
    private init();
    private getIndexes();
    private createTable(name, fields);
    private fillIndexTable(index, start?);
}
