# API Integration Guide

This guide explains how to connect Anvil Explorer to your own ABI endpoint.

## What This API Is For

The explorer can poll an HTTP endpoint for contract ABIs and optional address labels. This is useful if you want:

- deployment scripts to publish ABIs automatically
- a shared local service to provide ABIs for multiple projects
- labels such as `Treasury`, `Router`, or `Token` to appear automatically in the UI

The explorer does not require a custom endpoint. By default it uses the built-in local endpoint at `/api/abis`.

## How Users Configure It

Open the `ABIs` page in the explorer and set `ABI API Endpoint` to your service URL.

The frontend will then poll that endpoint automatically. The current implementation polls about every 3 seconds.

You can also set a default at build time with:

```text
VITE_ABI_API_URL
```

## Minimum Integration: `GET`

If you only want the explorer to pull data from your service, you only need to implement:

```text
GET /your-endpoint
```

The frontend accepts either of these response shapes:

```json
{
  "records": [
    {
      "address": "0xYourContractAddress",
      "label": "Treasury",
      "source": "[{\"type\":\"function\",...}]",
      "updatedAt": 1712345678901
    }
  ]
}
```

```json
[
  {
    "address": "0xYourContractAddress",
    "label": "Treasury",
    "source": "[{\"type\":\"function\",...}]",
    "updatedAt": 1712345678901
  }
]
```

Each record supports:

- `address`: required contract address
- `source`: required ABI JSON as a string
- `updatedAt`: required timestamp in milliseconds
- `label`: optional display label for that address

## Recommended Integration: `POST`

If you want deployment scripts or other tooling to push ABIs into your service, also implement:

```text
POST /your-endpoint
```

The explorer UI itself does not call `POST`, but supporting it makes automation much easier.

Accepted request shapes:

```json
{
  "address": "0xYourContractAddress",
  "label": "Treasury",
  "source": "[{\"type\":\"function\",\"name\":\"foo\",...}]"
}
```

```json
{
  "address": "0xYourContractAddress",
  "label": "Treasury",
  "abi": [{ "type": "function", "name": "foo", "inputs": [], "outputs": [] }]
}
```

```json
{
  "address": "0xYourContractAddress",
  "label": "Treasury",
  "artifact": {
    "abi": [{ "type": "function", "name": "foo", "inputs": [], "outputs": [] }]
  }
}
```

`label` and `updatedAt` are optional on upload. If `updatedAt` is omitted, using the current timestamp is a sensible default.

## Explorer Behavior

The explorer will:

- normalize addresses before storing them
- parse and validate ABI JSON before saving
- import newer or changed ABI records into IndexedDB
- store `label` as the saved address label when present

The explorer will not:

- delete local ABIs just because a record is missing from your endpoint
- require `POST` support if `GET` already provides the ABI records it needs

In practice, your endpoint works best when `updatedAt` increases whenever the ABI or label changes.

## Quick Example

Example `GET` response:

```json
{
  "records": [
    {
      "address": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      "label": "Token",
      "source": "[{\"type\":\"function\",\"name\":\"transfer\",\"inputs\":[{\"name\":\"to\",\"type\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"}]",
      "updatedAt": 1760000000000
    }
  ]
}
```

Example `POST` from a deployment script:

```bash
curl -X POST http://127.0.0.1:7777/api/abis \
  -H 'content-type: application/json' \
  --data '{
    "address": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "label": "Token",
    "artifact": {
      "abi": [
        {
          "type": "function",
          "name": "transfer",
          "inputs": [
            { "name": "to", "type": "address" },
            { "name": "amount", "type": "uint256" }
          ],
          "outputs": [],
          "stateMutability": "nonpayable"
        }
      ]
    }
  }'
```

## Compatibility Notes

- Return JSON with `content-type: application/json`.
- Setting `cache-control: no-store` is recommended so the explorer sees fresh ABI updates quickly.
- Keep `source` as a JSON string, even if your service stores ABIs internally as arrays or objects.
- If you already have an internal artifact store, converting `artifact.abi` into `source` for `GET` responses is usually the simplest integration.

## Built-in Local Endpoint

During local development, the project already provides a built-in endpoint at:

```text
/api/abis
```

That implementation is documented further in [DEVELOPER.md](./DEVELOPER.md).
