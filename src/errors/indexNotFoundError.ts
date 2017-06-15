
export default class IndexNotFoundError extends Error {
    status = 404;

    constructor(name: string) {
        super(`Index ${name} could not be found`);
    }
}