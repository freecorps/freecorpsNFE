/** Preserve the first failure while always closing the local transport. */
export async function cleanupOperationProof(retire, close, failure) {
  try {
    await retire();
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}
