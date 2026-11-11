// The evidence log of an upload, read back from the bucket it lives in (evidence/<upload id>/): what the system did, in order.
export async function evidenceOf(bucket, id) {
  const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(`evidence/${id}/`)).sort();
  return Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode(new Uint8Array(await (await bucket.get(k)).arrayBuffer())))));
}
