import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

const PROTO = fileURLToPath(new URL('../test/fixtures/grpc/echo.proto', import.meta.url));
let server;
let launched;

test.afterEach(async () => {
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
  if (server) {
    const current = server;
    server = null;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      current.tryShutdown(finish);
      const timer = setTimeout(() => {
        current.forceShutdown();
        finish();
      }, 250);
      timer.unref?.();
    });
  }
});

async function startGrpcServer() {
  const definition = protoLoader.loadSync(PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition);
  server = new grpc.Server();
  server.addService(loaded.relay.test.Echo.service, {
    Say(call, callback) {
      callback(null, { message: `${call.request.message}|${call.metadata.get('x-token')[0] || ''}`, count: 1 });
    },
    Count(call) {
      call.end();
    },
    Upload(call, callback) {
      const parts = [];
      call.on('data', (req) => parts.push(req.message));
      call.on('end', () => callback(null, { message: parts.join(','), count: parts.length }));
    },
    Chat(call) {
      call.on('data', (req) => call.write({ message: `echo ${req.message}`, count: 1 }));
      call.on('end', () => call.end());
    },
  });
  new ReflectionService(definition).addToServer(server);
  const port = await new Promise((resolve, reject) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (err, bound) => (err ? reject(err) : resolve(bound))
    );
  });
  return port;
}

test('uses server reflection and a bidirectional stream', async () => {
  const port = await startGrpcServer();
  const url = `grpc://127.0.0.1:${port}`;
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(
      {
        schemaVersion: 3,
        activeWorkspaceId: 'ws_grpc',
        workspaces: [
          {
            id: 'ws_grpc',
            name: 'Default',
            collections: [
              {
                id: 'col_grpc',
                name: 'gRPC',
                variables: [],
                items: [
                  {
                    id: 'req_grpc',
                    type: 'request',
                    name: 'Echo',
                    method: 'GET',
                    url,
                  },
                ],
              },
            ],
            environments: [],
            globals: [],
            history: [],
            activeEnvId: null,
          },
        ],
      },
      null,
      2
    )
  );

  launched = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = launched;

  await page.getByTestId('collections-expand-all').click();
  await page.getByText('Echo', { exact: true }).click();
  await page.getByTestId('grpc-reflection').check();
  await expect(page.getByTestId('grpc-service')).toContainText('relay.test.Echo', {
    timeout: 10000,
  });

  await page.getByTestId('grpc-service').selectOption('relay.test.Echo');
  await page.getByTestId('grpc-method').selectOption('Say');
  await page.getByTestId('grpc-message').fill('{"message":"hi"}');
  await page.getByTestId('grpc-invoke').click();
  await expect(page.getByTestId('grpc-result')).toContainText('hi|');

  await page.getByTestId('grpc-method').selectOption('Chat');
  await page.getByTestId('grpc-message').fill('{}');
  await page.getByTestId('grpc-stream').click();
  await expect(page.getByTestId('grpc-stream-message')).toBeVisible();
  await page.getByTestId('grpc-stream-message').fill('{"message":"yo"}');
  await page.getByTestId('grpc-stream-send').click();
  await expect(page.getByTestId('grpc-log')).toContainText('echo yo');
  await page.getByTestId('grpc-stream-end').click();
  await expect(page.getByTestId('grpc-log')).toContainText('OK');
});
