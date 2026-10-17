import assert from "node:assert/strict";
import { handleLoginRequest } from "../src/routes/auth.js";

const valid = handleLoginRequest({ username: "faisal", password: "quest" });
assert.equal(valid.status, 200);
assert.equal(valid.body.userId, "u-1");

const invalid = handleLoginRequest({ username: "missing", password: "wrong" });
assert.equal(invalid.status, 401);
assert.equal(invalid.body.error, "invalid credentials");

console.log("quest-shop tests passed");
