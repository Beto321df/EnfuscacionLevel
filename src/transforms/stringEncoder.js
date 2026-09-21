const { generate15Junk } = require('./renameVars');

class StringEncoderTransform {
    transformNode(node, stringTable) {
        if (!node) return node;

        if (node.type === 'StringLiteral') {
            const junkKey = generate15Junk();
            const charCodes = Array.from(node.value).map(c => c.charCodeAt(0) + 7);
            stringTable.set(junkKey, charCodes);
            return {
                type: 'EnvAccess',
                key: junkKey
            };
        }

        for (const key in node) {
            if (typeof node[key] === 'object' && node[key] !== null) {
                this.transformNode(node[key], stringTable);
            }
        }
        return node;
    }
}

module.exports = StringEncoderTransform;
