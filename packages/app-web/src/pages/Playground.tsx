import { useState } from 'react';
import { RELAYER_BASE } from '../relayerEndpoint';

/** Strip /relay suffix from RELAYER_BASE to get origin for full paths like /relay/status */
const RELAYER_ORIGIN = RELAYER_BASE.replace(/\/relay\/?$/, '');

interface FieldDef {
  name: string;
  type: 'query' | 'body';
  placeholder: string;
  valueType?: 'number';
}

interface EndpointDef {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  desc: string;
  fields: FieldDef[];
}

const endpoints: EndpointDef[] = [
  { id: 'status', method: 'GET', path: '/relay/status', desc: 'Health check', fields: [] },
  {
    id: 'config',
    method: 'GET',
    path: '/relay/config',
    desc: 'Network config & supported settlement swap paths',
    fields: [],
  },
  {
    id: 'prepare',
    method: 'POST',
    path: '/relay/prepare',
    desc: 'Build sponsored TX (422 on dry-run rejection)',
    fields: [
      { name: 'txKindBytes', type: 'body', placeholder: 'base64...' },
      { name: 'senderAddress', type: 'body', placeholder: '0x...' },
      { name: 'settlementTokenType', type: 'body', placeholder: '0x...::deep::DEEP (required)' },
      { name: 'slippageBps', type: 'body', placeholder: '200', valueType: 'number' },
      { name: 'gasMarginBps', type: 'body', placeholder: '1000', valueType: 'number' },
      { name: 'orderId', type: 'body', placeholder: 'order-123 (optional)' },
    ],
  },
  {
    id: 'sponsor',
    method: 'POST',
    path: '/relay/sponsor',
    desc: 'Sign + execute sponsored TX',
    fields: [
      { name: 'txBytes', type: 'body', placeholder: 'base64...' },
      { name: 'userSignature', type: 'body', placeholder: 'base64...' },
      { name: 'receiptId', type: 'body', placeholder: '0x...' },
    ],
  },
];

function parseSafeIntegerInput(name: string, value: string): number {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

export function PlaygroundPage() {
  const [selected, setSelected] = useState('status');
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<{ status: number; body: string } | null>(null);

  const ep = endpoints.find((e) => e.id === selected)!;

  const handleExecute = async () => {
    setLoading(true);
    setResponse(null);
    try {
      let url = `${RELAYER_ORIGIN}${ep.path}`;
      const init: RequestInit = {};
      if (ep.method === 'GET') {
        const params = new URLSearchParams();
        ep.fields.forEach((f) => {
          if (values[f.name]) params.set(f.name, values[f.name]);
        });
        const qs = params.toString();
        if (qs) url += '?' + qs;
        init.method = 'GET';
      } else {
        const body: Record<string, unknown> = {};
        ep.fields
          .filter((f) => f.type === 'body')
          .forEach((f) => {
            if (values[f.name]) {
              body[f.name] =
                f.valueType === 'number'
                  ? parseSafeIntegerInput(f.name, values[f.name])
                  : values[f.name];
            }
          });
        init.method = 'POST';
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let formatted: string;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        formatted = text;
      }
      setResponse({ status: res.status, body: formatted });
    } catch (err) {
      setResponse({
        status: 0,
        body: `Network error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setLoading(false);
    }
  };

  const curlCommand = () => {
    if (ep.method === 'GET') {
      const params = new URLSearchParams();
      ep.fields.forEach((f) => {
        if (values[f.name]) params.set(f.name, values[f.name]);
      });
      const qs = params.toString();
      return `curl "${RELAYER_ORIGIN}${ep.path}${qs ? '?' + qs : ''}"`;
    }
    const body: Record<string, string> = {};
    ep.fields
      .filter((f) => f.type === 'body')
      .forEach((f) => {
        if (values[f.name]) body[f.name] = values[f.name];
      });
    return `curl -X POST "${RELAYER_ORIGIN}${ep.path}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body)}'`;
  };

  return (
    <div className="page">
      <h1 className="page-title">API Playground</h1>
      <p className="page-subtitle">
        Select an endpoint, fill in the parameters, and click Execute. Prepare-stage simulation
        failures return 422 domain errors, so compare responses against
        <code>docs/api.md</code> instead of assuming every failure is an internal crash.
      </p>

      <div className="tabs">
        {endpoints.map((e) => (
          <button
            key={e.id}
            className={`tab ${selected === e.id ? 'active' : ''}`}
            onClick={() => {
              setSelected(e.id);
              setResponse(null);
            }}
          >
            <span
              className={`method-badge ${e.method.toLowerCase()}`}
              style={{ marginRight: 8, fontSize: 10, padding: '2px 6px' }}
            >
              {e.method}
            </span>
            {e.path.replace('/relay/', '')}
          </button>
        ))}
      </div>

      <div className="endpoint-card" style={{ borderColor: 'var(--border)' }}>
        <div className="endpoint-header" style={{ cursor: 'default' }}>
          <span className={`method-badge ${ep.method.toLowerCase()}`}>{ep.method}</span>
          <span className="endpoint-path">{ep.path}</span>
          <span className="endpoint-desc">{ep.desc}</span>
        </div>
        <div className="endpoint-body">
          {ep.fields.length > 0 ? (
            <div className="playground-form">
              {ep.fields.map((f) => (
                <div key={f.name} className="form-group">
                  <label className="form-label">{f.name}</label>
                  {f.name === 'txKindBytes' || f.name === 'txBytes' ? (
                    <textarea
                      className="form-input form-textarea"
                      placeholder={f.placeholder}
                      value={values[f.name] || ''}
                      onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    />
                  ) : (
                    <input
                      className="form-input"
                      type="text"
                      placeholder={f.placeholder}
                      value={values[f.name] || ''}
                      onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
              No parameters required — execute directly.
            </p>
          )}

          <button className="btn-execute" onClick={handleExecute} disabled={loading}>
            {loading ? (
              <>
                <span className="loading-dot">●</span> Executing...
              </>
            ) : (
              '▶ Execute'
            )}
          </button>

          <div className="code-label">curl</div>
          <pre className="code-block">{curlCommand()}</pre>

          {response && (
            <div className="response-section">
              <div
                className={`response-status ${response.status >= 200 && response.status < 300 ? 'ok' : 'error'}`}
              >
                {response.status === 0
                  ? '⚠ Network Error'
                  : `${response.status} ${response.status < 300 ? 'OK' : 'Error'}`}
              </div>
              <pre className="code-block">{response.body}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default PlaygroundPage;
