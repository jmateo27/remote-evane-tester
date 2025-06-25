import machine
import time
import aioble
import bluetooth
import asyncio
from collections import deque

class EnableInterface:
    ENABLE_PIN = 16
    ENABLE_RISE_TIME_S = 0.001

    def __init__(self):
        self.pin = machine.Pin(self.ENABLE_PIN, machine.Pin.OUT, machine.Pin.PULL_DOWN, value=0)

    def on(self):
        self.pin.value(1)

    def off(self):
        self.pin.value(0)

class ADCInterface:
    VANE_READING_PIN = 28
    VREF_READING_PIN = 27

    ADC_MAX_VOLTAGE = 3.3
    ADC_MAX_READING = 65535

    def __init__(self):
        self.vane_adc = machine.ADC(self.VANE_READING_PIN)
        self.vref_adc = machine.ADC(self.VREF_READING_PIN)

    def measure_vane(self):
        return self.vane_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING

    def measure_vref(self):
        return self.vref_adc.read_u16() * self.ADC_MAX_VOLTAGE / self.ADC_MAX_READING

class MainBluetoothTransmission:
    BLE_NAME = "TRANSMITTER"
    BLE_SVC_UUID = bluetooth.UUID(0x181A)
    BLE_CHARACTERISTIC_UUID = bluetooth.UUID(0x2A6E)
    BLE_APPEARANCE = 0x0300
    BLE_ADVERTISING_INTERVAL = 100
    SEND_LATENCY_MS = 250

    SWITCH_PIN = 17
    DEBOUNCE_TIME_MS = 500

    def __init__(self):
        self.enable = EnableInterface()
        self.adcs = ADCInterface()
        self.DEQUE_SIZE = 50
        self.readings = deque([], self.DEQUE_SIZE)
        self.vane_init = None

        self.switch_pin = machine.Pin(self.SWITCH_PIN, machine.Pin.IN, machine.Pin.PULL_UP)
        self.switch_pin.irq(trigger=machine.Pin.IRQ_RISING, handler = self.switch_handler)
        self.switch_time_prev = -1
        
    async def set_baseline(self):
        self.vane_init, _ = await self.measurement()
        
    async def measurement(self):
        self.enable.on()
        await asyncio.sleep(self.enable.ENABLE_RISE_TIME_S)
        vane_val = self.adcs.measure_vane()
        vref_val = self.adcs.measure_vref()
        self.enable.off()
        await asyncio.sleep(self.enable.ENABLE_RISE_TIME_S)
        return (vane_val, vref_val)

    def encode_message(self, message: str) -> bytes:
        return message.encode('utf-8')

    async def get_smoothed_vane(self):
        new_reading, vref = await self.measurement()
        self.readings.append(new_reading)
        return (sum(self.readings) / len(self.readings), vref)
    
    def switch_handler(self, pin):
        if time.ticks_ms() - self.switch_time_prev > self.DEBOUNCE_TIME_MS:
            self.switch_time_prev = time.ticks_ms()
            if self.switch_pin.value() == 0:
                asyncio.create_task(self.set_baseline())
                print("Baseline re-evaluated")

    async def send_data_task(self, connection, characteristic):
        msg_iter = 0
        send_iter = 0
        while connection.is_connected():
            start_time = time.ticks_ms()

            try:
                smoothed_reading, vref = await self.get_smoothed_vane()
                send_iter = (send_iter + 1) % self.DEQUE_SIZE
                if send_iter > 0:
                    elapsed = time.ticks_ms() - start_time
                    await asyncio.sleep_ms(int(self.SEND_LATENCY_MS / self.DEQUE_SIZE - elapsed))
                    continue
#                 reading = await self.measurement()
                if msg_iter == 0:
                    msg = f"B{self.vane_init:.6f},{smoothed_reading:.6f}"
                else:
                    msg = f"V{vref:.6f},{smoothed_reading:.6f}"
                
                msg_iter = (msg_iter + 1) % 3

                print(f"Sending message: {msg}")
                await characteristic.notify(connection, self.encode_message(msg))
    
            except TypeError as e:
                if "'NoneType' object isn't iterable" in str(e):
                      elapsed = time.ticks_ms() - start_time
                      await asyncio.sleep_ms(int(self.SEND_LATENCY_MS / self.DEQUE_SIZE - elapsed))
#                       await asyncio.sleep_ms(int(self.SEND_LATENCY_MS - elapsed))
                      print(f"Loop took {elapsed} ms, max is {self.SEND_LATENCY_MS / self.DEQUE_SIZE}")
#                       print(f"Loop took {elapsed} ms, max is {self.SEND_LATENCY_MS}")
                      continue
                else:
                    print(f"Notify error: {type(e).__name__}: {e}")
            except Exception as e:
                print(f"Notify error: {type(e).__name__}: {e}")
            
            print("Why are we here")
            elapsed = time.ticks_ms() - start_time
            await asyncio.sleep_ms(int(self.SEND_LATENCY_MS / self.DEQUE_SIZE - elapsed))

    async def run_transmitter_mode(self):
        ble_service = aioble.Service(self.BLE_SVC_UUID)
        characteristic = aioble.Characteristic(
            ble_service,
            self.BLE_CHARACTERISTIC_UUID,
            notify=True
        )
        aioble.register_services(ble_service)

        print(f"{self.BLE_NAME} advertising...")

        while True:
            async with await aioble.advertise(
                self.BLE_ADVERTISING_INTERVAL,
                name=self.BLE_NAME,
                services=[self.BLE_SVC_UUID],
                appearance=self.BLE_APPEARANCE,
            ) as connection:
                print(f"Connected to {connection.device}")
                await self.send_data_task(connection, characteristic)
                print("Disconnected")
                print(f"{self.BLE_NAME} advertising...")

async def main():
    transmitter = MainBluetoothTransmission()
    await transmitter.set_baseline()
    while True:
        await transmitter.run_transmitter_mode()

if __name__ == "__main__":
    asyncio.run(main())
