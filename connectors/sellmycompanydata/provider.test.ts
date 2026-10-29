import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Json, RunInput } from "@shared/core";
import { directTransport, Engine } from "@monid/connector-engine";
import {
    assertInputAccepted,
    estimateEndpoint,
    type Fixture,
    loadFixture,
    runEndpoint,
    testBundle,
    testSealedUnit,
} from "@shared/testing";

const FIXTURES = fromFileUrl(new URL("./fixtures/", import.meta.url));
const MCP_URL = "https://sellmycompanydata.com/mcp";
const CHECKLIST = "sellmycompanydata#assessment-checklist";
const ESTIMATE = "sellmycompanydata#estimate-data-value";
const CHECKLIST_RPC_ID = "sellmycompanydata-assessment-checklist";
const ESTIMATE_RPC_ID = "sellmycompanydata-estimate-data-value";
const FREE = { credits: {}, evidence: {} };
const UNEXPECTED = "Sell My Company Data returned an unexpected response";
const META = {
    "io.modelcontextprotocol/clientInfo": { name: "monid", version: "1.0.0" },
};
/** Every header that leaves the process. */
const WIRE_HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
};

/** The figures behind the recorded estimates: made up, no real company. */
const UK_60: Record<string, Json> = {
    employees: 60,
    founded_year: 2015,
    country: "uk",
    systems: [
        {
            tool: "Slack",
            category: "chat",
            since_year: 2016,
            volume: "400k messages",
            measured: false,
        },
        { tool: "HubSpot", category: "crm", since_year: 2017 },
        { tool: "Zendesk", category: "support", since_year: 2018 },
    ],
    slack_public_share: "half",
};
const US_8: Record<string, Json> = {
    employees: 8,
    founded_year: 2023,
    country: "us",
    systems: [{ tool: "Slack", category: "chat", since_year: 2023 }],
};

/** Each recorded chain, the endpoint it serves and the input behind it. */
const RECORDED: { fixture: string; id: string; input: RunInput }[] = [
    { fixture: "checklist-ok", id: CHECKLIST, input: {} },
    { fixture: "estimate-ok", id: ESTIMATE, input: { body: UK_60 } },
    { fixture: "estimate-below-bar", id: ESTIMATE, input: { body: US_8 } },
    {
        fixture: "estimate-refused",
        id: ESTIMATE,
        input: { body: { ...UK_60, founded_year: 2030 } },
    },
];

function fixture(name: string): Promise<Fixture> {
    return loadFixture(`${FIXTURES}${name}.json`);
}

async function replay(id: string, fx: Fixture, input: RunInput) {
    const unit = await testSealedUnit(id);
    return await runEndpoint({ unit, input, mode: "replay", fixture: fx });
}

/** A one-call chain for envelopes no honest request records. */
function oneCall(name: string, status: number, body: Json): Fixture {
    return {
        name,
        description: `Synthetic ${name} envelope, shaped after the ` +
            "server's JSON-RPC handler.",
        calls: [{
            req: { method: "POST", url: "{{request.url}}" },
            res: { status, body },
        }],
    };
}

/** The structuredContent of a recorded success. */
function structuredOf(fx: Fixture): Record<string, Json> {
    return (fx.calls[0].res.body as {
        result: { structuredContent: Record<string, Json> };
    }).result.structuredContent;
}

interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Json;
}

/** Engine wired to a capturing fetch: what actually leaves the process. */
function captureEngine(seen: Seen[], respond: () => Response): Engine {
    return new Engine({
        transport: directTransport({
            // the docs declare no credential field, so nothing is resolved
            params: () => Promise.resolve({}),
            fetch: (input, init) => {
                seen.push({
                    url: String(input),
                    method: init?.method ?? "GET",
                    headers: Object.fromEntries(new Headers(init?.headers)),
                    ...(typeof init?.body === "string"
                        ? { body: JSON.parse(init.body) as Json }
                        : {}),
                });
                return Promise.resolve(respond());
            },
        }),
    });
}

function json(status: number, body: Json): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function rpcSuccess(id: string, structuredContent: Json): Json {
    return {
        jsonrpc: "2.0",
        id,
        result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent,
        },
    };
}

function isPointedAtEstimateUrl(nextStep: Json | undefined): boolean {
    return typeof nextStep === "string" && nextStep.includes("estimate_url") &&
        !nextStep.includes("call request_offer");
}

Deno.test("sellmycompanydata: two read-only MCP tools, keyless, FREE, no request_offer", async () => {
    const bundle = await testBundle();
    const ids = Object.keys(bundle.endpoints).filter((id) =>
        id.startsWith("sellmycompanydata#")
    ).sort();
    // read-only on purpose: request_offer is not ported
    assertEquals(ids, [CHECKLIST, ESTIMATE]);

    const checklist = bundle.endpoints[CHECKLIST];
    const estimate = bundle.endpoints[ESTIMATE];
    const synthesized = checklist.usage.evidence.$fn.key;
    assertEquals(
        bundle.fnTable[synthesized].provenance,
        "core#usage.synthesizedEmpty",
    );
    assert(checklist.lifecycle?.start, "provider lifecycle.start resolves");
    assert(checklist.output.fromError, "provider fromError resolves");
    for (const doc of [checklist, estimate]) {
        assertEquals(doc.request.method, "POST", doc.id);
        assertEquals(doc.request.url, MCP_URL, doc.id);
        assertEquals(doc.request.headers, {
            accept: WIRE_HEADERS.accept,
            "mcp-protocol-version": WIRE_HEADERS["mcp-protocol-version"],
        }, doc.id);
        // keyless: one identity inject, an empty credential shape
        assertEquals(
            Object.keys(
                (doc.auth.credentials as { properties?: object })
                    .properties ?? {},
            ),
            [],
            doc.id,
        );
        assertEquals(
            doc.auth.inject.$fn.key,
            checklist.auth.inject.$fn.key,
            doc.id,
        );
        // FREE: no meter, compiler-synthesized quantities
        assertEquals(doc.usage.model.kind, "FREE", doc.id);
        assertEquals(doc.usage.consolidate, undefined, doc.id);
        assertEquals(doc.usage.evidence.$fn.key, synthesized, doc.id);
        assertEquals(doc.usage.estimate.$fn.key, synthesized, doc.id);
        // one envelope check and one error digest serve both tools
        assertEquals(
            doc.lifecycle?.start?.$fn.key,
            checklist.lifecycle?.start?.$fn.key,
            doc.id,
        );
        assertEquals(
            doc.output.fromError?.$fn.key,
            checklist.output.fromError?.$fn.key,
            doc.id,
        );
        // each endpoint pins its own tool name
        assert(doc.input.toRequest, doc.id);
        assertEquals(doc.timeouts.requestMs, 15_000, doc.id);
        assertEquals(doc.timeouts.runMs, 20_000, doc.id);
        assert(
            bundle.taxonomy.membership["funding-data"].includes(doc.id),
            doc.id,
        );
    }
    assert(
        checklist.input.toRequest?.$fn.key !==
            estimate.input.toRequest?.$fn.key,
    );
    // only the estimate takes arguments
    assertEquals(checklist.input.schema.body, undefined);
    assert(estimate.input.schema.body);
    // the estimate swaps one field, so it carries its own presentation fn
    assert(
        estimate.output.fromResponse?.$fn.key !==
            checklist.output.fromResponse?.$fn.key,
    );
});

Deno.test("sellmycompanydata: the pre-run estimate is zero for both tools", async () => {
    assertEquals(
        await estimateEndpoint(await testSealedUnit(CHECKLIST), {}),
        FREE,
    );
    assertEquals(
        await estimateEndpoint(await testSealedUnit(ESTIMATE), { body: UK_60 }),
        FREE,
    );
});

Deno.test("fixtures: each recorded request body is the one the connector sends", async () => {
    for (const { fixture: name, id, input } of RECORDED) {
        const fx = await fixture(name);
        const seen: Seen[] = [];
        const engine = captureEngine(
            seen,
            () => json(fx.calls[0].res.status, fx.calls[0].res.body),
        );
        await (await engine.load(await testSealedUnit(id))).run(input);
        assertEquals(seen.length, 1, name);
        assertEquals(seen[0].body, fx.calls[0].req.body, name);
    }
});

Deno.test("checklist: the recorded answer replays as structuredContent at zero usage", async () => {
    const fx = await fixture("checklist-ok");
    const result = await replay(CHECKLIST, fx, {});
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    assertEquals(result.providerHttpStatus, undefined);
    assertEquals(result.usage, FREE);
    assertEquals(result.output, structuredOf(fx));
    const out = result.output as {
        privacy_rule: string;
        categories: { category: string }[];
    };
    assert(out.privacy_rule.startsWith("Counts and date ranges only."));
    assertEquals(out.categories.map((c) => c.category), [
        "chat",
        "crm",
        "support",
        "docs",
        "code",
        "email",
        "project",
        "finance",
    ]);
});

Deno.test("estimate: recorded answers replay field for field; only next_step is ours", async () => {
    for (const name of ["estimate-ok", "estimate-below-bar"]) {
        const { id, input } = RECORDED.find((r) => r.fixture === name)!;
        const fx = await fixture(name);
        const result = await replay(id, fx, input);
        assertEquals(result.httpStatus, 200, name);
        assertEquals(result.isProviderError, false, name);
        assertEquals(result.usage, FREE, name);
        const { next_step: ours, ...rest } = result.output as Record<
            string,
            Json
        >;
        const { next_step: theirs, ...recorded } = structuredOf(fx);
        assertEquals(rest, recorded, name);
        // the server's own step names request_offer, which is not here
        assert(String(theirs).includes("call request_offer"), name);
        assert(isPointedAtEstimateUrl(ours), name);
    }

    const ok = (await replay(
        ESTIMATE,
        await fixture("estimate-ok"),
        { body: UK_60 },
    )).output as Record<string, Json>;
    assertEquals(ok.qualifies, true);
    assertEquals(
        ok.headline,
        "Estimated range: $238K – $460K (United Kingdom).",
    );
    assertEquals([ok.low_usd, ok.high_usd], [237882, 460446]);
    assert(
        String(ok.estimate_url).startsWith(
            "https://sellmycompanydata.com/?e=60&f=2015&c=uk",
        ),
    );

    const small = (await replay(
        ESTIMATE,
        await fixture("estimate-below-bar"),
        { body: US_8 },
    )).output as Record<string, Json>;
    assertEquals(small.qualifies, false);
    assertEquals(small.below_bar, true);
    assertEquals([small.low_usd, small.high_usd], [40000, 113500]);
});

Deno.test("estimate: the server's own refusal (HTTP 200, isError) is a zero-billed provider error", async () => {
    const fx = await fixture("estimate-refused");
    const result = await replay(ESTIMATE, fx, {
        body: { ...UK_60, founded_year: 2030 },
    });
    // OURS 422 (the tool refused) / THEIRS 200 (the exchange succeeded)
    assertEquals(result.httpStatus, 422);
    assertEquals(result.providerHttpStatus, 200);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, FREE);
    assertEquals(result.output, {
        message: "founded_year must be between 1800 and 2026. Ask the user " +
            "for the missing or corrected value and call again.",
        raw: fx.calls[0].res.body,
    });
});

Deno.test("estimate: JSON-RPC errors, HTTP errors and malformed envelopes settle at zero", async () => {
    const cases: {
        name: string;
        status: number;
        body: Json;
        httpStatus: number;
        providerHttpStatus?: number;
        message: string;
        code?: number;
    }[] = [
        {
            name: "rpc-error",
            status: 200,
            body: {
                jsonrpc: "2.0",
                id: ESTIMATE_RPC_ID,
                error: { code: -32602, message: "Unknown tool: x" },
            },
            httpStatus: 422,
            providerHttpStatus: 200,
            message: "Unknown tool: x",
            code: -32602,
        },
        {
            name: "mismatched-id",
            status: 200,
            body: rpcSuccess("another-request", { estimate: true }),
            httpStatus: 422,
            providerHttpStatus: 200,
            message: UNEXPECTED,
        },
        {
            name: "wrong-jsonrpc-version",
            status: 200,
            body: {
                jsonrpc: "1.0",
                id: ESTIMATE_RPC_ID,
                result: { structuredContent: { estimate: true } },
            },
            httpStatus: 422,
            providerHttpStatus: 200,
            message: UNEXPECTED,
        },
        {
            name: "no-structured-content",
            status: 200,
            body: {
                jsonrpc: "2.0",
                id: ESTIMATE_RPC_ID,
                result: { content: [{ type: "text", text: "ok" }] },
            },
            httpStatus: 422,
            providerHttpStatus: 200,
            message: UNEXPECTED,
        },
        {
            name: "array-structured-content",
            status: 200,
            body: rpcSuccess(ESTIMATE_RPC_ID, [1, 2]),
            httpStatus: 422,
            providerHttpStatus: 200,
            message: UNEXPECTED,
        },
        {
            name: "non-boolean-is-error",
            status: 200,
            body: {
                jsonrpc: "2.0",
                id: ESTIMATE_RPC_ID,
                result: { isError: "yes", structuredContent: {} },
            },
            httpStatus: 422,
            providerHttpStatus: 200,
            message: UNEXPECTED,
        },
        {
            name: "parse-error",
            status: 400,
            body: {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error." },
            },
            httpStatus: 400,
            message: "Parse error.",
            code: -32700,
        },
        {
            name: "not-found",
            status: 404,
            body: { error: "not_found" },
            httpStatus: 404,
            message: "not_found",
        },
    ];
    for (const c of cases) {
        const result = await replay(
            ESTIMATE,
            oneCall(c.name, c.status, c.body),
            { body: UK_60 },
        );
        assertEquals(result.httpStatus, c.httpStatus, c.name);
        assertEquals(result.providerHttpStatus, c.providerHttpStatus, c.name);
        assertEquals(result.isProviderError, true, c.name);
        assertEquals(result.usage, FREE, c.name);
        assertEquals(result.output, {
            message: c.message,
            ...(c.code !== undefined ? { code: c.code } : {}),
            raw: c.body,
        }, c.name);
    }
});

Deno.test("estimate: the binding rejects what the server's schema rejects, before any call", async () => {
    const sys: Record<string, Json> = { tool: "Slack", category: "chat" };
    const base: Record<string, Json> = {
        employees: 60,
        founded_year: 2015,
        country: "uk",
        systems: [sys],
    };
    const rejected: [string, Json][] = [
        ["empty body", {}],
        ["no systems", { employees: 60, founded_year: 2015, country: "uk" }],
        ["employees 0", { ...base, employees: 0 }],
        ["employees over the cap", { ...base, employees: 1_000_001 }],
        ["employees not whole", { ...base, employees: 2.5 }],
        ["founded before 1800", { ...base, founded_year: 1799 }],
        ["unknown country", { ...base, country: "fr" }],
        ["systems as text", { ...base, systems: "Slack, HubSpot" }],
        [
            "31 systems",
            { ...base, systems: Array.from({ length: 31 }, () => sys) },
        ],
        ["system without category", { ...base, systems: [{ tool: "Slack" }] }],
        [
            "unknown category",
            { ...base, systems: [{ tool: "Slack", category: "wiki" }] },
        ],
        [
            "empty tool name",
            { ...base, systems: [{ tool: "", category: "chat" }] },
        ],
        [
            "tool name over 80",
            { ...base, systems: [{ tool: "x".repeat(81), category: "chat" }] },
        ],
        [
            "since_year before 1980",
            { ...base, systems: [{ ...sys, since_year: 1979 }] },
        ],
        [
            "volume over 120",
            { ...base, systems: [{ ...sys, volume: "9".repeat(121) }] },
        ],
        ["negative people", { ...base, systems: [{ ...sys, people: -1 }] }],
        [
            "unknown exportable",
            { ...base, systems: [{ ...sys, exportable: "maybe" }] },
        ],
        ["measured as text", {
            ...base,
            systems: [{ ...sys, measured: "yes" }],
        }],
        [
            "message content in a system",
            { ...base, systems: [{ ...sys, content: "message text" }] },
        ],
        ["unknown Slack share", { ...base, slack_public_share: "all" }],
        ["contact details", { ...base, email: "owner@example.com" }],
        ["a tool name", { ...base, name: "request_offer" }],
    ];
    const unit = await testSealedUnit(ESTIMATE);
    // no fixture: any upstream call would itself fail the test
    await assertRejects(
        () => runEndpoint({ unit, input: {}, mode: "replay" }),
        Error,
        "INVALID_INPUT",
        "no body at all",
    );
    for (const [why, body] of rejected) {
        await assertRejects(
            () => runEndpoint({ unit, input: { body }, mode: "replay" }),
            Error,
            "INVALID_INPUT",
            why,
        );
    }
    // near-twins of those bounds clear the gate (replay matches method +
    // url, not body)
    const ok = await fixture("estimate-ok");
    const passing: Json[] = [
        { ...base, systems: [] },
        {
            ...base,
            employees: 1,
            founded_year: 1800,
            systems: Array.from({ length: 30 }, () => sys),
        },
        { ...base, employees: 1_000_000 },
        {
            ...base,
            slack_public_share: "no_slack",
            systems: [{
                tool: "x".repeat(80),
                category: "other",
                since_year: 1980,
                volume: "9".repeat(120),
                people: 0,
                exportable: "unsure",
                measured: true,
            }],
        },
    ];
    for (const body of passing) {
        await assertInputAccepted({
            unit,
            input: { body },
            mode: "replay",
            fixture: ok,
        });
    }
});

Deno.test("egress: one POST to /mcp, the pinned tools/call envelope, no credential", async () => {
    const seen: Seen[] = [];
    const engine = captureEngine(
        seen,
        () =>
            json(
                200,
                rpcSuccess(ESTIMATE_RPC_ID, {
                    estimate: true,
                    next_step: "Then call request_offer.",
                }),
            ),
    );
    const loaded = await engine.load(await testSealedUnit(ESTIMATE));
    // query params have no schema here and never reach the wire
    const result = await loaded.run({
        body: UK_60,
        queryParams: { utm_source: "x" },
    });
    assertEquals(result.isProviderError, false);
    const out = result.output as Record<string, Json>;
    assertEquals(out.estimate, true);
    assert(isPointedAtEstimateUrl(out.next_step));
    assertEquals(seen.length, 1);
    assertEquals(seen[0].url, MCP_URL);
    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].headers, WIRE_HEADERS);
    assertEquals(seen[0].body, {
        jsonrpc: "2.0",
        id: ESTIMATE_RPC_ID,
        method: "tools/call",
        params: { name: "estimate_data_value", arguments: UK_60, _meta: META },
    });
});

Deno.test("egress: the checklist forwards nothing a caller sends", async () => {
    const seen: Seen[] = [];
    const engine = captureEngine(
        seen,
        () => json(200, rpcSuccess(CHECKLIST_RPC_ID, { rules: [] })),
    );
    const loaded = await engine.load(await testSealedUnit(CHECKLIST));
    const result = await loaded.run({
        body: {
            name: "request_offer",
            arguments: { email: "owner@example.com" },
        },
        queryParams: { q: "1" },
    });
    assertEquals(result.isProviderError, false);
    assertEquals(result.output, { rules: [] });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].url, MCP_URL);
    assertEquals(seen[0].headers, WIRE_HEADERS);
    assertEquals(seen[0].body, {
        jsonrpc: "2.0",
        id: CHECKLIST_RPC_ID,
        method: "tools/call",
        params: { name: "assessment_checklist", arguments: {}, _meta: META },
    });
});

Deno.test("egress: a non-JSON 5xx from the edge is data, zero usage", async () => {
    // replay always serves JSON, so this drives a real text/plain body
    const seen: Seen[] = [];
    const engine = captureEngine(
        seen,
        () =>
            new Response("error code: 1101", {
                status: 500,
                headers: { "content-type": "text/plain" },
            }),
    );
    const loaded = await engine.load(await testSealedUnit(ESTIMATE));
    const result = await loaded.run({ body: UK_60 });
    assertEquals(result.httpStatus, 500);
    assertEquals(result.providerHttpStatus, undefined);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, FREE);
    assertEquals(result.output, {
        message: UNEXPECTED,
        raw: "error code: 1101",
    });
    assertEquals(seen.length, 1);
});

Deno.test({
    name: "sellmycompanydata live (gated on SELLMYCOMPANYDATA_LIVE=1; keyless)",
    ignore: Deno.env.get("SELLMYCOMPANYDATA_LIVE") !== "1",
    fn: async () => {
        const checklist = await runEndpoint({
            unit: await testSealedUnit(CHECKLIST),
            input: {},
            mode: "live",
        });
        assertEquals(
            checklist.isProviderError,
            false,
            JSON.stringify(checklist.output),
        );
        assertEquals(checklist.usage, FREE);
        const estimate = await runEndpoint({
            unit: await testSealedUnit(ESTIMATE),
            input: { body: UK_60 },
            mode: "live",
        });
        assertEquals(
            estimate.isProviderError,
            false,
            JSON.stringify(estimate.output),
        );
        assertEquals(estimate.usage, FREE);
        const out = estimate.output as Record<string, Json>;
        assertEquals(out.estimate, true);
        assertEquals(typeof out.low_usd, "number");
        assert(
            String(out.estimate_url).startsWith(
                "https://sellmycompanydata.com/?",
            ),
        );
        assert(isPointedAtEstimateUrl(out.next_step));
    },
});
