#!/usr/bin/env bun
import {
	openuiChatExamples,
	openuiChatLibrary,
	openuiExamples,
	openuiLibrary,
} from "@openuidev/react-ui";

const p1 = openuiLibrary.prompt({ preamble: "" });
const p2 = openuiChatLibrary.prompt({ preamble: "" });
console.log(`openuiLibrary prompt:     ${p1.length.toLocaleString()} chars`);
console.log(`openuiChatLibrary prompt: ${p2.length.toLocaleString()} chars`);
console.log(`openuiExamples:           ${openuiExamples.length} examples`);
console.log(`openuiChatExamples:       ${openuiChatExamples.length} examples`);
console.log("\n--- first chat example ---");
console.log(openuiChatExamples[0]?.slice(0, 600));
