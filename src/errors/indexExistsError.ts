
export default class IndexExistsError extends Error {
    constructor(name: string) {
        super(`Index ${name} already exists`);
    }
}