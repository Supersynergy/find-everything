declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    readonly inTransaction: boolean;
    exec(sql: string): void;
    function(name: string, options: { deterministic?: boolean }, callback: (...args: any[]) => any): void;
    query(sql: string): { all(...args: any[]): any[]; get(...args: any[]): any; run(...args: any[]): any; iterate(...args: any[]): IterableIterator<any> };
    transaction<T extends (...args: any[]) => any>(callback: T): T;
    close(): void;
  }
}
