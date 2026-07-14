#!/usr/bin/env python3
import argparse
import json
import os
import sys
from typing import Any

from azure.ai.projects import AIProjectClient
from azure.identity import AzureCliCredential, DefaultAzureCredential


DEFAULT_PROMPT = """Return your answer as one exact JSON object only.

Required outer wrapper:
- wrapper_version
- agent_identity
- request_echo
- agent_result

Rules:
- Do not return markdown.
- Do not return prose before or after the JSON object.
- Use wrapper_version = foundry_boundary_wrapper_v1.
- Use agent_result.schema_version = foundry_boundary_agent_response_v1.
- Keep the actual task outcome only inside agent_result.
- If request_id, run_id, workflow_id, workflow_version, or node_id were not supplied in this prompt, set them to null.

Task:
Tell me what you can help with.

Return only the JSON object.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test Azure AI Foundry project agent output shape.")
    parser.add_argument(
        "--endpoint",
        default=os.getenv("KAIF_FOUNDRY_AGENT_PROJECT_ENDPOINT", "https://example-resource.services.ai.azure.com/api/projects/kindred-1882"),
        help="Azure AI Foundry project endpoint",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("KAIF_FOUNDRY_AGENT_MODEL", "gpt-5-mini"),
        help="Underlying model deployment name",
    )
    parser.add_argument(
        "--agent-name",
        default=os.getenv("KAIF_FOUNDRY_AGENT_NAME", "BoundaryAgent"),
        help="Foundry agent name",
    )
    parser.add_argument(
        "--agent-version",
        default=os.getenv("KAIF_FOUNDRY_AGENT_VERSION", "2"),
        help="Foundry agent version",
    )
    parser.add_argument(
        "--credential",
        choices=("azure_cli", "default"),
        default=os.getenv("KAIF_FOUNDRY_AGENT_CREDENTIAL", "azure_cli"),
        help="Credential mode",
    )
    parser.add_argument(
        "--prompt-file",
        help="Optional path to a prompt file. Defaults to the built-in wrapper prompt.",
    )
    return parser.parse_args()


def load_prompt(path: str | None) -> str:
    if not path:
        return DEFAULT_PROMPT
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def get_credential(mode: str):
    if mode == "default":
        return DefaultAzureCredential()
    return AzureCliCredential()


def fail(message: str, *, payload: Any | None = None) -> int:
    print(message, file=sys.stderr)
    if payload is not None:
        try:
            rendered = json.dumps(payload, indent=2, ensure_ascii=True)
        except Exception:
            rendered = str(payload)
        print(rendered, file=sys.stderr)
    return 1


def main() -> int:
    args = parse_args()
    prompt = load_prompt(args.prompt_file)
    credential = get_credential(args.credential)
    client = AIProjectClient(endpoint=args.endpoint, credential=credential)
    openai_client = client.get_openai_client()

    response = openai_client.responses.create(
        model=args.model,
        input=[{"role": "user", "content": prompt}],
        extra_body={
            "agent_reference": {
                "name": args.agent_name,
                "version": args.agent_version,
                "type": "agent_reference",
            }
        },
    )

    output_text = response.output_text
    print("RAW_OUTPUT_START")
    print(output_text)
    print("RAW_OUTPUT_END")

    try:
        payload = json.loads(output_text)
    except json.JSONDecodeError as exc:
        return fail(f"Response is not valid JSON: {exc}")

    required_keys = ["wrapper_version", "agent_identity", "request_echo", "agent_result"]
    missing = [key for key in required_keys if key not in payload]
    if missing:
        return fail(f"Missing required wrapper keys: {', '.join(missing)}", payload=payload)

    if payload["wrapper_version"] != "foundry_boundary_wrapper_v1":
        return fail(
            "wrapper_version mismatch",
            payload={"expected": "foundry_boundary_wrapper_v1", "actual": payload["wrapper_version"]},
        )

    agent_result = payload.get("agent_result")
    if not isinstance(agent_result, dict):
        return fail("agent_result must be a JSON object", payload=payload)

    if agent_result.get("schema_version") != "foundry_boundary_agent_response_v1":
        return fail(
            "agent_result.schema_version mismatch",
            payload={
                "expected": "foundry_boundary_agent_response_v1",
                "actual": agent_result.get("schema_version"),
            },
        )

    print("VALIDATION=PASS")
    print(
        json.dumps(
            {
                "wrapper_version": payload["wrapper_version"],
                "agent_identity": payload.get("agent_identity"),
                "request_echo": payload.get("request_echo"),
                "agent_result_keys": sorted(agent_result.keys()),
            },
            indent=2,
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
