class ZNode {
    constructor(type, props = {}) {
        this.type = type;
        Object.assign(this, props);
    }
}

function node(type, props) { return new ZNode(type, props); }

module.exports = { ZNode, node };
