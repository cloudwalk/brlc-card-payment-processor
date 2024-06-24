import { expect } from "chai";

export interface EventParameterCheckingOptions {
  showValuesInErrorMessage?: boolean;
  caseInsensitiveComparison?: boolean;
  convertToJson?: boolean;
}

interface Stringable {
  toString(): string;
}

function checkEventParameter<T extends Stringable>(
  fieldName: string,
  expectedValue: T | string | undefined | null,
  options: EventParameterCheckingOptions = {}
): (value: T) => boolean {
  const f = function (value: T | string): boolean {
    if (options.convertToJson) {
      value = JSON.stringify(value);
      expectedValue = JSON.stringify(expectedValue);
    }
    let errorMessage = `The "${fieldName}" field of the event is wrong`;
    if (options.showValuesInErrorMessage) {
      errorMessage += ` (actual: ${value} ; expected: ${expectedValue})`;
    }
    if (options.caseInsensitiveComparison) {
      value = value.toString().toLowerCase();
      expectedValue = expectedValue?.toString()?.toLowerCase();
    }
    expect(value).to.equal(expectedValue, errorMessage);
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventField_${fieldName}`, writable: false });
  return f;
}

function checkEventParameterNotEqual<T extends Stringable>(
  fieldName: string,
  notExpectedValue: T | string | undefined | null,
  options: EventParameterCheckingOptions = {}
): (value: T | string) => boolean {
  const f = function (value: T | string): boolean {
    if (options.convertToJson) {
      value = JSON.stringify(value);
      notExpectedValue = JSON.stringify(notExpectedValue);
    }
    let errorMessage =
      `The "${fieldName}" field of the event is wrong because it is equal ${notExpectedValue} but should not`;
    if (options.showValuesInErrorMessage) {
      errorMessage += ` (actual: ${value} ; not expected: ${notExpectedValue})`;
    }
    if (options.caseInsensitiveComparison) {
      value = value.toString().toLowerCase();
      notExpectedValue = notExpectedValue?.toString()?.toLowerCase();
    }
    expect(value).not.to.equal(notExpectedValue, errorMessage);
    return true;
  };
  Object.defineProperty(f, "name", { value: `checkEventFieldNot_${fieldName}`, writable: false });
  return f;
}

export {
  checkEventParameter,
  checkEventParameterNotEqual
};
