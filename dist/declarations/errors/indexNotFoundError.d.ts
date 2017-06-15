export default class IndexNotFoundError extends Error {
    status: number;
    constructor(name: string);
}
