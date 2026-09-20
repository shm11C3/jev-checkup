import type { Questions } from "../types.js";

/**
 * The production question template.  Keep the wording in sync with the
 * clean-room draft; placeholders are expanded once per prepared target.
 */
export const testQuestionsTemplate = {
  "{test_key}__outcome_unasserted": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Do the assertions in `target_tests.{test_key}.code` all check something other than the outcome stated in `target_tests.{test_key}.title`?",
      setup_scope:
        "Setup counts wherever it appears in `source`: module-level mocks and the default values they return, hoisted mock objects, beforeEach and beforeAll hooks of every enclosing describe block, helper and fixture functions the test calls, and mocked translation tables that turn keys into the texts the assertions look for.",
    },
    criteria: {
      true:
        "The title states an outcome, and no expect in the test would fail if that outcome stopped happening. The expects check other things, such as a message, a log call, an unrelated field, or only that something exists.",
      false:
        "At least one expect checks the stated outcome itself, either directly or at a mocked boundary that the title is about. An expect inside a helper function that the test calls counts.",
    },
  },
  "{test_key}__result_claim_call_only": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Does `target_tests.{test_key}.title` describe what a result contains, while the assertions in `target_tests.{test_key}.code` only check that a function was called?",
    },
    criteria: {
      true:
        "The title describes a resulting value, order, list or state. Every expect only checks that a mock or spy was called, or how many times, without checking its arguments or anything it produced.",
      false:
        "An expect checks call arguments, a return value, rendered output or stored state. Or the title only says that an action is triggered, and the call itself is that action.",
    },
  },
  "{test_key}__call_claim_no_call_check": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Does `target_tests.{test_key}.title` say that a particular function is called or is not called, while no assertion in `target_tests.{test_key}.code` inspects the calls of that function?",
    },
    criteria: {
      true:
        "The title is about a call happening or not happening, and the expects only look at values, state or rendered output.",
      false:
        "An expect inspects the calls of the function the title names: called, not called, or called with. Or the title is not about a function call.",
    },
  },
  "{test_key}__subject_not_in_play": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Does `target_tests.{test_key}.code` run without ever creating, passing or comparing the condition, input or mechanism that `target_tests.{test_key}.title` names?",
      setup_scope:
        "Setup counts wherever it appears in `source`: module-level mocks and the default values they return, hoisted mock objects, beforeEach and beforeAll hooks of every enclosing describe block, helper and fixture functions the test calls, and mocked translation tables that turn keys into the texts the assertions look for.",
    },
    criteria: {
      true:
        "Even counting shared setup, nothing in the test creates, passes or compares the thing the title names. Examples: the title names an ordering clause and nothing in the test involves order; the title names a locale and no locale is set or compared; the title is about one item among others being skipped and the input holds no items at all.",
      false:
        "The named condition is created in the test body or in shared setup, even if no line of the test body mentions it. Or it is simply the initial state before anything has happened.",
    },
  },
  "{test_key}__extra_claim_unasserted": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Does `target_tests.{test_key}.title` state a second behaviour or detail that no assertion in `target_tests.{test_key}.code` checks?",
    },
    criteria: {
      true:
        "The title joins two or more checkable claims, for example with 'and', 'with', 'only', 'per' or 'so'. At least one of them is asserted, and at least one other has no expect that would fail if it broke.",
      false:
        "Every checkable claim in the title has an expect, or the title states a single claim. Wording that only explains why the behaviour matters, or how it is meant to be used, is not a claim.",
    },
  },
  "{test_key}__general_claim_single_case": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Does `target_tests.{test_key}.title` generalise over every, each, all, only or repeated occurrences, while `target_tests.{test_key}.code` exercises a single occurrence?",
    },
    criteria: {
      true:
        "The title generalises, with words such as every update, each item, only when, again or always. The test triggers the behaviour once or with one item, so the general claim and a narrower one would pass alike.",
      false:
        "The test exercises several occurrences or contrasting cases. Or other tests in the same describe block of `source` exercise the contrasting cases. Or the title does not generalise.",
    },
  },
  "{test_key}__vague_title": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Is `target_tests.{test_key}.title` too vague to name an expected result?",
    },
    criteria: {
      true:
        "The title only says that the code works, handles something, or behaves correctly or properly, without saying what the result should be.",
      false: "The title names a concrete behaviour or result.",
    },
  },
  "{test_key}__assertion_specificity": {
    type: "score",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "How specific are the assertions in `target_tests.{test_key}.code`?",
      focus:
        "Judge the strongest expect in the test. An expect inside a helper function that the test calls counts.",
    },
    criteria: [
      "At least one expect compares a produced value, rendered text, stored state or call arguments against an exact expected value, or asserts that a specific thing is absent.",
      "The strongest expect only matches a pattern or a partial shape: a regular expression, a substring, 'some element matches', or a loose inequality.",
      "The expects only check that something exists, is defined, is non-empty, has a type or has some length, or that a function was called without checking its arguments.",
    ],
  },
  "{test_key}__hinges_on_unseen_rule": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Is `target_tests.{test_key}.code` arranged around a particular number, limit or timing rule that is not stated anywhere in `source`?",
    },
    criteria: {
      true:
        "The test repeats an event a particular number of times, waits a particular time, or picks a particular size, and whether that is enough to trigger the behaviour in the title depends on a limit defined in the code under test that is neither shown nor mentioned in this file.",
      false:
        "The inputs and expected values speak for themselves, or the relevant number is defined or mentioned in this file, including in a comment. Merely calling imported code does not count.",
    },
  },
  "{test_key}__verdict": {
    type: "choice",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      question:
        "Judging only from `source`, how do the assertions in `target_tests.{test_key}.code` relate to what `target_tests.{test_key}.title` states?",
      setup_scope:
        "Setup counts wherever it appears in `source`: module-level mocks and the default values they return, hoisted mock objects, beforeEach and beforeAll hooks of every enclosing describe block, helper and fixture functions the test calls, and mocked translation tables that turn keys into the texts the assertions look for.",
    },
    criteria: {
      verifies: "At least one expect would fail if the behaviour stated in the title broke.",
      verifies_part:
        "The main behaviour in the title is asserted, and another behaviour or detail stated in the title is not.",
      does_not_verify:
        "There are expects, but none of them would fail if the behaviour stated in the title broke.",
      cannot_tell_from_file:
        "Whether an expect would fail depends on code, constants or rules that are not visible in this file.",
    },
  },
  "{test_key}__ctl_own_snippet": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      snippet: "{own_snippet}",
      question:
        "Does `target_tests.{test_key}.code` contain the text in `snippet`?",
    },
  },
  "{test_key}__ctl_sibling_snippet": {
    type: "noul",
    instructions: {
      target_test: {
        title: "{title}",
        inside: "{describe_path}",
        lines_in_source: "{start_line_id} to {end_line_id}",
      },
      snippet: "{sibling_snippet}",
      question:
        "Does `target_tests.{test_key}.code` contain the text in `snippet`?",
    },
  },
} as const satisfies Questions;
