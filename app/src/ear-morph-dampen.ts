/** Soften expression-driven yanks of ear meshes.
 *
 * Some models bind ear vertices into blink expressions (model1's blink
 * morphs displace ear verts up to ~8cm in 150ms), which reads as teleporting.
 * The manager rewrites every influence from zero on each update, so scaling
 * the ear slots down right after the update is exact and stable — eyelids
 * keep full weight while spring bones own the ear motion.
 *
 * Pure module (structural types only) so it unit-tests with plain node.
 */

/** Fraction of expression weight the ear meshes keep. */
export const EAR_MORPH_DAMPEN = 0.35

export interface EarMorphMesh {
  name?: string
  morphTargetInfluences?: number[] | null
}

export interface EarMorphBindLike {
  primitives?: EarMorphMesh[] | null
  index?: unknown
}

export interface EarMorphExpressionLike {
  binds?: readonly unknown[] | null
}

export interface EarMorphSlot {
  mesh: EarMorphMesh
  index: number
}

/** Collect (mesh, morphIndex) slots on ear-named meshes from expression binds. */
export function collectEarMorphSlots(
  expressions: readonly unknown[] | undefined | null,
  pattern = /ear/i,
): EarMorphSlot[] {
  const slots: EarMorphSlot[] = []
  if (!expressions) return slots
  for (const expr of expressions) {
    const binds = (expr as EarMorphExpressionLike | null | undefined)?.binds ?? []
    for (const raw of binds) {
      const bind = raw as EarMorphBindLike | null | undefined
      if (typeof bind?.index !== 'number') continue
      for (const prim of bind.primitives ?? []) {
        if (!prim || !pattern.test(prim.name ?? '')) continue
        if (!slots.some((s) => s.mesh === prim && s.index === bind.index)) {
          slots.push({ mesh: prim, index: bind.index })
        }
      }
    }
  }
  return slots
}

/** Scale recorded ear-slot influences (no-op on missing influence arrays). */
export function dampenEarMorphs(slots: readonly EarMorphSlot[], factor = EAR_MORPH_DAMPEN): void {
  for (const slot of slots) {
    const influences = slot.mesh.morphTargetInfluences
    if (influences && slot.index >= 0 && slot.index < influences.length) {
      influences[slot.index] *= factor
    }
  }
}
