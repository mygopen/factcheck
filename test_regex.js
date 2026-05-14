const COMMAND_PATTERN = /(?:^|\s)(?:查核|factcheck|\/factcheck)(?:\s|$)/i;

function stripSlackMentions(text) {
  return text.replace(/<@[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function isFactcheckTrigger(event) {
  const text = stripSlackMentions(event.text || "");
  if (COMMAND_PATTERN.test(text)) return true;
  if (event.type !== "app_mention") return false;
  return isMentionOnlyText(text);
}

function isMentionOnlyText(text) {
  return text.replace(/[\s:：,，.。!！?？-]/g, "").trim() === "";
}

const testCases = [
  { type: "app_mention", text: "<@U12345>", expected: true },
  { type: "app_mention", text: "<@U12345>:", expected: true },
  { type: "app_mention", text: "<@U12345>：", expected: true },
  { type: "app_mention", text: "<@U12345> 查核", expected: true },
  { type: "app_mention", text: "<@U12345>查核", expected: true },
  { type: "message", text: "查核", expected: true },
  { type: "message", text: "  查核  ", expected: true },
  { type: "app_mention", text: "<@U12345> 查核這篇", expected: false },
  { type: "app_mention", text: "<@U12345>: 查核", expected: true },
  { type: "message", text: "factcheck", expected: true },
  { type: "message", text: "/factcheck", expected: true },
  { type: "message", text: "<@U12345>", expected: false },
  { type: "app_mention", text: "<@U12345> hello", expected: false }
];

let failures = 0;

testCases.forEach((event) => {
  const stripped = stripSlackMentions(event.text);
  const matched = isFactcheckTrigger(event);
  if (matched !== event.expected) failures += 1;
  console.log(`Type: ${event.type} Input: "${event.text}" -> Stripped: "${stripped}" -> Matched: ${matched} Expected: ${event.expected}`);
});

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
