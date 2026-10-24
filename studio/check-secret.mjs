import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const chunks = await p.knowledgeChunk.findMany({
  where: { doc: { source: 'project' } },
  select: { content: true, doc: { select: { path: true, sourceRoot: true } } },
});
const withSecret = chunks.filter((c) => c.content.includes('sk-never-index-me'));
const roots = [...new Set(chunks.map((c) => c.doc.sourceRoot))];
console.log('total project chunks:', chunks.length);
console.log('roots indexed:', JSON.stringify(roots));
console.log('chunks containing the secret:', withSecret.length);
const paths = [...new Set(chunks.map((c) => c.doc.path))];
console.log('env-ish paths indexed:', JSON.stringify(paths.filter((x) => /(^|\/)\.env|\.pem$|credentials/i.test(x))));
await p.$disconnect();
