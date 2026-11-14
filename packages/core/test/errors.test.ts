import { describe, expect, it } from "vitest";
import { parseErrorBody, toTypedError, AuthError, RateLimitError, ValidationError, ServerError } from "../src/errors.js";

describe("errors", () => {
  it("parses verified envelope", () => {
    expect(
      parseErrorBody({ status_code: 422, message: "Bad", error: { code: "bad", details: ["a"] }, data: null }),
    ).toMatchObject({ message: "Bad", code: "bad", details: ["a"] });
  });

  it("maps statuses", () => {
    expect(toTypedError(401, { message: "x" })).toBeInstanceOf(AuthError);
    expect(toTypedError(429, { message: "x" })).toBeInstanceOf(RateLimitError);
    expect(toTypedError(422, { message: "x" })).toBeInstanceOf(ValidationError);
    expect(toTypedError(500, { message: "x" })).toBeInstanceOf(ServerError);
  });

  it("never throws on garbage bodies", () => {
    expect(parseErrorBody(undefined)).toMatchObject({ message: "Request failed" });
    expect(parseErrorBody("oops")).toMatchObject({ message: "oops" });
  });
});
