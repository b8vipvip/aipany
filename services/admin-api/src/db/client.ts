import pg from "pg";
export type DbClient=Pick<pg.Pool,"query">;
export function createPool(connectionString:string):pg.Pool{return new pg.Pool({connectionString});}
