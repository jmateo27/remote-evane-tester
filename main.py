import machine
import time

ENABLE_LATENCY_S = 1.0

class Enable_Interface:
    ENABLE_PIN = 16
    def __init__(self):
        self.pin = machine.Pin(self.ENABLE_PIN, machine.Pin.OUT, value=0)
    
    def on(self):
        self.pin.value(1)

    def off(self):
        self.pin.value(0)
    
if __name__ == "__main__":
    enable = Enable_Interface()
    while True:
        time.sleep(ENABLE_LATENCY_S)
        enable.on()
        time.sleep(ENABLE_LATENCY_S)
        enable.off()
