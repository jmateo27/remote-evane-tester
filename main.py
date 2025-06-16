import machine
import time

ENABLE_LATENCY_S = 1.0
MEASUREMENT_LATENCY_MS = 1000

class Enable_Interface:
    ENABLE_PIN = 16
    def __init__(self):
        self.pin = machine.Pin(self.ENABLE_PIN, machine.Pin.OUT, value=0)
    
    def on(self):
        self.pin.value(1)

    def off(self):
        self.pin.value(0)

class ADC_Interface:
    VANE_READING_PIN = 28
    VREF_READING_PIN = 27

    # Constants for ADC conversion
    ADC_MAX_VOLTAGE = 3.3        # Reference voltage for ADC (typically 3.3V on RP2040)
    ADC_MAX_READING = 0xFFFF     # 16-bit maximum value for ADC (65535)

    def __init__(self):
        self.vane_adc = machine.ADC(self.VANE_READING_PIN)
        self.vref_adc = machine.ADC(self.VREF_READING_PIN)

    def measure_vane(self):
        return self.vane_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING

    def measure_vref(self):
        return self.vref_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING
    
if __name__ == "__main__":
    enable = Enable_Interface()
    adcs = ADC_Interface()
    
    enable.on()
    
    time.sleep(3) # Wait to get baseline
    vane_init = adcs.measure_vane()
    vref_init = adcs.measure_vref()
    while True:
        time.sleep_ms(MEASUREMENT_LATENCY_MS)
        measurement = adcs.measure_vane()
        print(f'Baseline:{vane_init}, Reading:{measurement}, Value:{measurement-vane_init}')
