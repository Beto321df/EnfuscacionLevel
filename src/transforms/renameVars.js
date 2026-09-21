function generate15Junk() {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789[];'\\/.,-=!@#$%^&*()_";
    let res = "";
    for (let i = 0; i < 15; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

class RenameVarsTransform {
    constructor() {
        this.varMap = new Map();
        this.envKey = generate15Junk();
    }

    getJunkName(originalName) {
        if (!this.varMap.has(originalName)) {
            this.varMap.set(originalName, generate15Junk());
        }
        return this.varMap.get(originalName);
    }

    transform(ast) {
        return ast;
    }
}

module.exports = { RenameVarsTransform, generate15Junk };
