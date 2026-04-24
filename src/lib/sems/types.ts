export type SemsPlant = {
  id: string;
  name: string;
};

export type SemsInverter = {
  id: string;
  name: string;
  serialNumber: string | null;
  status: string;
  powerKw: number;
  dayGenerationKwh: number;
  totalGenerationKwh: number;
};

export type SemsHourlyPoint = {
  timestamp: string;
  powerKw: number;
};

export type SemsDailyPoint = {
  date: string;
  generationKwh: number;
};

export type SemsPlantSnapshot = {
  plantId: string;
  plantName: string;
  location: string | null;
  totalGenerationKwh: number;
  todayGenerationKwh: number;
  monthGenerationKwh: number;
  currentPowerKw: number;
  status: string;
  inverters: SemsInverter[];
  hourlyChart: SemsHourlyPoint[];
  dailyHistory: SemsDailyPoint[];
  monthlyHistory: SemsDailyPoint[];
  errorLog?: string;
};
