# Nyvex Z3 — estudio de arquitectura de referencias

## Objetivo

Prometheus, AzureVM y Clyde se usan como referencias técnicas para estudiar separación de frontend, IR/compiler, bytecode y VM. Nyvex no copia sus implementaciones.

## Decisiones incorporadas

| Área | Prometheus | AzureVM | Clyde | Nyvex Z3 |
|---|---|---|---|---|
| Lexer/parser/AST | Sí | heredado | Sí | Sí |
| Transform pipeline | Sí | Sí | Sí | Sí |
| ZIR/IR propio | — | — | bytecode propio | ZIR v2 |
| Stack VM | no como backend principal | VM-oriented | Sí | Sí, compatibilidad |
| Register VM | no | parcial/VM-oriented | Sí | Sí, backend principal |
| Closures/upvalues explícitos | scope-aware | VM dependent | Sí | Sí |
| Multi-return | limitado por transforms | VM dependent | Sí | Sí |
| Superinstructions | no central | backend-specific | Sí | Sí |
| Fused compare/branch | no central | backend-specific | Sí | Sí |
| Per-function opcode map | no central | encoder-dependent | Sí | Sí |
| Per-function register permutation | no | no central | Sí | Sí |
| Per-instruction operand schemas | no | no | no central | Sí |
| Lazy constant pool | no central | decoder-dependent | no central | Sí |
| Encoded branch targets | no central | format-dependent | VM-dependent | Sí |
| Generated runtime | no | Sí | Sí | Sí |
| Visual transport | no | no | no | Sí |
| Semantic verifier | AST/scopes | backend-dependent | compiler validation | Sí, antes del packing |
| Randomized stability tests | no comparable harness | no comparable harness | no comparable harness | Sí |

## Lo que no se copió

No se importaron archivos fuente de las tres referencias. Se tomaron patrones arquitectónicos y se implementaron dentro de las estructuras Z3 existentes.

## Resultado de diseño

La ventaja buscada no es hacer el ZIP grande por sí mismo. El peso extra debe corresponder a responsabilidades reales: una VM de registros, metadatos explícitos, validación, diversificación del formato, decodificación lazy y pruebas de compatibilidad.

## Límite de la afirmación

La matriz compara capacidades implementadas. No demuestra que Nyvex tenga una resistencia universalmente superior a otro ofuscador. Esa afirmación requiere un benchmark común con las mismas entradas, herramientas de análisis y métricas.
