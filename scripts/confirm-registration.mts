type Lifetime = { blockhash: string; lastValidBlockHeight: number };

/** A confirmed signature can still represent a failed instruction. */
export async function confirmRegistration(
  signature: string,
  lifetime: Lifetime,
  confirm: (strategy: Lifetime & { signature: string }) => Promise<{ value: { err: unknown } }>,
  providerExists: () => Promise<boolean>,
) {
  const result = await confirm({ signature, ...lifetime });
  if (result.value.err !== null) throw new Error('Clinic registration transaction failed');
  if (!(await providerExists())) throw new Error('Clinic Provider was not created');
}
