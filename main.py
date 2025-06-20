import machine
import time
import aioble
import bluetooth
import asyncio
from collections import deque

class EnableInterface:
    ENABLE_PIN = 16
    ENABLE_RISE_TIME_S = 0.1

    def __init__(self):
        self.pin = machine.Pin(self.ENABLE_PIN, machine.Pin.OUT, value=0)

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
    BLE_ADVERTISING_INTERVAL = 2000
    SEND_LATENCY_S = 0.1

    def __init__(self):
        self.enable = EnableInterface()
        self.adcs = ADCInterface()
        self.readings = deque([], 10)

        self.enable.off()
        time.sleep(3)
        self.enable.on()
        time.sleep(self.enable.ENABLE_RISE_TIME_S)
        self.vane_init = self.adcs.measure_vane()
        self.readings.append(self.vane_init)
        self.enable.off()

    def encode_message(self, message: str) -> bytes:
        return message.encode('utf-8')

    def get_smoothed_vane(self):
        new_reading = self.adcs.measure_vane()
        self.readings.append(new_reading)
        return sum(self.readings) / len(self.readings)

    async def send_data_task(self, connection, characteristic):
        iter = 0
        while connection.is_connected():
            self.enable.on()
            await asyncio.sleep(self.enable.ENABLE_RISE_TIME_S)

            try:
                if iter == 0:
                    msg = f"B{self.vane_init:.6f},{self.get_smoothed_vane():.6f}"
                else:
                    msg = f"V{self.adcs.measure_vref():.6f},{self.get_smoothed_vane():.6f}"
                self.enable.off()
                iter = (iter + 1) % 3

                print(f"Sending message: {msg}")
                await characteristic.notify(connection, self.encode_message(msg))

            except Exception as e:
                print(f"Notify error: {type(e).__name__}: {e}")
                await asyncio.sleep(0.5)

            await asyncio.sleep(self.SEND_LATENCY_S)

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

async def main():
    transmitter = MainBluetoothTransmission()
    while True:
        await transmitter.run_transmitter_mode()

if __name__ == "__main__":
    asyncio.run(main())
