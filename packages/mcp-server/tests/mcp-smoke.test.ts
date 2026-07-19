import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';
import { afterEach, describe, expect, it } from 'vitest';

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
});

describe('MCP stdio server', () => {
  it('starts and lists Stelis tools', async () => {
    const client = new Client({ name: 'stelis-mcp-test-client', version: '0.0.0' });
    openClients.push(client);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        STELIS_RELAY_API_URL: 'https://host.example/relay',
      },
      stderr: 'pipe',
    });

    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'stelis_get_relay_api_config',
        'stelis_prepare_sponsored_transaction',
        'stelis_submit_signed_transaction',
        'stelis_list_promotions',
        'stelis_get_promotion_detail',
        'stelis_claim_promotion',
        'stelis_prepare_promotion_sponsored_transaction',
        'stelis_submit_signed_promotion_sponsored_transaction',
      ]),
    );

    const listPromotions = result.tools.find((tool) => tool.name === 'stelis_list_promotions');
    expect(listPromotions?.inputSchema).toMatchObject({
      properties: {
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: NODE_TIMER_MAX_DELAY_MS },
      },
    });

    const invalidCursor = await client.callTool({
      name: 'stelis_list_promotions',
      arguments: { developerJwt: 'jwt', cursor: 'promotion-1' },
    });
    expect(invalidCursor.isError).toBe(true);
    expect(JSON.stringify(invalidCursor.content)).toContain('canonical lowercase UUID-v4');
  });
});
