export default class AxeBuilder {
  withTags() {
    return this;
  }
  async analyze() {
    return { violations: [], incomplete: [] };
  }
}
