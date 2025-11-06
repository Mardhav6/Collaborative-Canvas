const esbuild = require('esbuild');
const path = require('path');

async function build() {
  const serverUrl = process.env.SERVER_URL || '';
  await esbuild.build({
    entryPoints: [path.join('client', 'main.ts')],
    bundle: true,
    sourcemap: true,
    outfile: path.join('client', 'dist', 'bundle.js'),
    define: {
      SERVICE_SERVER_URL: JSON.stringify(serverUrl),
    },
    loader: { '.ts': 'ts' },
  });
  console.log('Built client with SERVICE_SERVER_URL =', JSON.stringify(serverUrl));
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});


