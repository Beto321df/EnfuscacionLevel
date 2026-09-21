const { generate15Junk } = require('./renameVars');

class FlowFlatteningTransform {
    flatten(statements) {
        const stateVar = generate15Junk();
        const states = statements.map((stmt, idx) => ({
            id: idx + 1,
            stmt: stmt,
            next: idx + 2 <= statements.length ? idx + 2 : null
        }));

        return {
            type: 'FlattenedFlow',
            stateVar: stateVar,
            states: states
        };
    }
}

module.exports = FlowFlatteningTransform;
