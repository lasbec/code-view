export const normalizeAuthorEmail = email => email.trim().toLowerCase();

export function normalizeAuthorIdentities(value = []) {
  const fail = message => { throw new Error(`Author identities: ${message}`); };
  if (!Array.isArray(value)) fail('provide a list of names, primary emails and aliases.');
  const used = new Set();
  const email = value => {
    if (typeof value !== 'string' || !/^[^\s<>@]+@[^\s<>@]+$/.test(value.trim())) fail('provide valid email addresses.');
    const normalized = normalizeAuthorEmail(value);
    if (used.has(normalized)) fail(`email ${normalized} belongs to more than one entry.`);
    used.add(normalized);
    return normalized;
  };
  return value.map(identity => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      Object.keys(identity).some(key => !['name', 'email', 'aliases'].includes(key)) ||
      typeof identity.name !== 'string' || !identity.name.trim() ||
      !Array.isArray(identity.aliases ?? [])) fail('each entry needs a name, primary email and optional alias list.');
    return { name: identity.name.trim(), email: email(identity.email), aliases: (identity.aliases ?? []).map(email) };
  });
}
