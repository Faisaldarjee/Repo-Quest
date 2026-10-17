import assert from "node:assert/strict";
import { handleLoginRequest } from "../src/routes/auth.js";

process.env.REPOQUEST_TRACE = "1";
const response = handleLoginRequest({ username: "faisal", password: "quest" });
assert.equal(response.status, 200);
