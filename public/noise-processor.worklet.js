// Continuous noise generator (no buffer loop). type: 0=white, 1=pink, 2=brown.

class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'type', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1 }
    ]
  }

  constructor() {
    super()
    this.b0 = 0
    this.b1 = 0
    this.b2 = 0
    this.b3 = 0
    this.b4 = 0
    this.b5 = 0
    this.b6 = 0
    this.brownLast = 0
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0]?.[0]
    if (!output) return true

    const type = parameters.type[0]
    const active = parameters.active[0] > 0.5

    for (let i = 0; i < output.length; i++) {
      if (!active) {
        output[i] = 0
        continue
      }

      const white = Math.random() * 2 - 1
      let sample

      if (type < 0.5) {
        sample = white
      } else if (type < 1.5) {
        this.b0 = 0.99886 * this.b0 + white * 0.0555179
        this.b1 = 0.99332 * this.b1 + white * 0.0750759
        this.b2 = 0.969 * this.b2 + white * 0.153852
        this.b3 = 0.8665 * this.b3 + white * 0.3104856
        this.b4 = 0.55 * this.b4 + white * 0.5329522
        this.b5 = -0.7616 * this.b5 - white * 0.016898
        sample = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362) * 0.11
        this.b6 = white * 0.115926
      } else {
        this.brownLast = (this.brownLast + 0.02 * white) / 1.02
        sample = this.brownLast * 3.5
      }

      output[i] = sample
    }

    return true
  }
}

registerProcessor('noise-processor', NoiseProcessor)
