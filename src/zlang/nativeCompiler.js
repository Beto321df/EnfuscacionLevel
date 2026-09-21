let luaparse = null;
function getLuaParse() { if (!luaparse) luaparse = require('luaparse'); return luaparse; }
const { parse } = require('./parser');
const { buildProgram, buildProgramFromAst } = require('./compiler3');
const { normalizeIR, polymorphIR } = require('./ir');

function buildNativeProgram(source, options = {}) {
    if (typeof source !== 'string' || !source.trim()) throw new TypeError('Z3: el código fuente está vacío.');
    const shouldPolymorph = options.polymorphic !== false;

    try {
        const ast = parse(source, options);
        let program = buildProgramFromAst(ast);
        if (shouldPolymorph) program = polymorphIR(program, options.polymorphOptions);
        return normalizeIR(program, { frontend: 'native', fallback: false, polymorphic: shouldPolymorph });
    } catch (nativeError) {
        if (options.fallback === false) throw nativeError;

        // Compatibility path: luaparse must produce a tree that the compiler
        // actually knows how to consume. Do not feed a raw luaparse tree into
        // Z's native AST builder because their node shapes are intentionally
        // different. The compiler's source frontend owns the conversion.
        let program;
        try {
            program = buildProgram(source, {
                parser: 'luaparse',
                luaVersion: '5.1'
            });
        } catch (compilerFallbackError) {
            // Keep the explicit luaparse parse as a diagnostic/compatibility
            // route. When the compiler itself rejects a construct we preserve
            // that useful compiler error instead of misleadingly reporting a
            // native-AST "unsupported node" error.
            try {
                getLuaParse().parse(source, {
                    wait: false,
                    comments: false,
                    scope: false,
                    locations: false,
                    ranges: false,
                    luaVersion: '5.1'
                });
            } catch (parseError) {
                throw parseError;
            }
            throw compilerFallbackError;
        }

        if (shouldPolymorph) program = polymorphIR(program, options.polymorphOptions);
        return normalizeIR(program, {
            frontend: 'luaparse-fallback',
            fallback: true,
            nativeError: nativeError.message,
            polymorphic: shouldPolymorph
        });
    }
}

function parseNative(source) { return parse(source); }

module.exports = { buildNativeProgram, parseNative };