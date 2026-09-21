const { generate15Junk } = require('./renameVars');

class DeadCodeTransform {
    generateDeadNode() {
        const junkVar = generate15Junk();
        const val1 = Math.floor(Math.random() * 900) + 100;
        const val2 = Math.floor(Math.random() * 900) + 100;

        return {
            type: 'DeadStatement',
            code: `_E["${junkVar}"] = (${val1} * ${val2}) - ${Math.floor(val1 / 2)}`
        };
    }

    inject(statements) {
        const result = [];
        for (const stmt of statements) {
            result.push(stmt);
            if (Math.random() > 0.4) {
                result.push(this.generateDeadNode());
            }
        }
        return result;
    }
}

module.exports = DeadCodeTransform;
