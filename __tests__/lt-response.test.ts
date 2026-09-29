import { test, expect, describe } from "bun:test";
import { parseLtBody } from "../lt-response";

const BASE = "http://localhost:8081";

describe("parseLtBody", () => {
  test("returns the parsed body of a LanguageTool answer", () => {
    const body = JSON.stringify({ matches: [], language: { code: "en-US" } });
    expect(parseLtBody(body, BASE)).toEqual({ matches: [], language: { code: "en-US" } });
  });

  test("a non-JSON answer names the URL and the setting to check", () => {
    expect(() => parseLtBody("Super45 Radio - HLS: /hls/live.m3u8", BASE)).toThrow(
      /http:\/\/localhost:8081 did not answer like LanguageTool.*LANGUAGETOOL_URL/s,
    );
  });

  test("shows the start of what the server actually said", () => {
    expect(() => parseLtBody("<html><body>404 Not Found</body></html>", BASE)).toThrow(
      /<html><body>404 Not Found/,
    );
  });

  test("JSON without a matches array is not a LanguageTool answer", () => {
    expect(() => parseLtBody(JSON.stringify({ error: "nope" }), BASE)).toThrow(
      /did not answer like LanguageTool/,
    );
  });

  test("long bodies are cut in the message", () => {
    const err = (() => {
      try {
        parseLtBody("x".repeat(5000), BASE);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err!.message.length).toBeLessThan(400);
  });
});
