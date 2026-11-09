/// <reference types="vite/client" />
import { test } from "vite-plus/test";
export const modules = import.meta.glob("./**/*.*s");

test("setup", () => {});
